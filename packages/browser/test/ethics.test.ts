/**
 * Етика звернень (DEV-18) і бот-захист (§48, DEV-42): юніти (robots, пауза, лічильник за добу, розпізнавання) + інтеграція
 * на міні-фікстурі fixtures/bot через secureLaunch. Запуск: bash scripts/run-as-sitelens.sh pnpm test
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBotFixture } from "../../../fixtures/bot/server.js";
import { auditSite } from "../src/audit/run-site.js";
import { detectBotProtection, type BotInput } from "../src/audit/botprotect.js";
import { DailyAuditLimiter, HONEST_USER_AGENT, HostGate, MIN_DELAY_MS, parseRobots, robotsPolicyFromResponse, robotsVerdict, type RobotsPolicy } from "../src/audit/ethics.js";
import { secureLaunch, type SecureBrowser } from "../src/secure-launch.js";

const pol = (txt: string): RobotsPolicy => ({ groups: parseRobots(txt), fetch: "ok" });

describe("robots.txt (юніт)", () => {
  it("Disallow/Allow: довше правило виграє; за рівності Allow; порожній Disallow дозволяє все", () => {
    const p = pol("User-agent: *\nDisallow: /a/\nAllow: /a/open\nDisallow: /a/open/closed\nDisallow: /same\nAllow: /same\n");
    expect(robotsVerdict(p, "/a/x")).toEqual({ allowed: false, rule: "Disallow: /a/" });
    expect(robotsVerdict(p, "/a/open")).toEqual({ allowed: true, rule: "Allow: /a/open" });
    expect(robotsVerdict(p, "/a/open/closed/z").allowed).toBe(false);
    expect(robotsVerdict(p, "/same").allowed).toBe(true);
    expect(robotsVerdict(p, "/b").allowed).toBe(true);
    expect(robotsVerdict(pol("User-agent: *\nDisallow:\n"), "/x").allowed).toBe(true);
  });
  it("група нашого UA перекриває `*`; без неї — `*`; кілька User-agent в одній групі; коментарі; шаблони * і $", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: GoogleBot\nUser-agent: SiteLensBot # ми\nDisallow: /private\n";
    expect(robotsVerdict(pol(txt), "/shop").allowed).toBe(true);
    expect(robotsVerdict(pol(txt), "/private/x").allowed).toBe(false);
    expect(robotsVerdict(pol("User-agent: *\nDisallow: /\n"), "/shop").allowed).toBe(false);
    const w = pol("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/x\n");
    expect(robotsVerdict(w, "/a/b.pdf").allowed).toBe(false);
    expect(robotsVerdict(w, "/a/b.pdf?x=1").allowed).toBe(true);
    expect(robotsVerdict(w, "/tmp12/x").allowed).toBe(false);
  });
  it("статуси robots.txt: 200 → правила; 404 → усе дозволено; 5xx/429/мережа → усе заборонено (RFC 9309)", () => {
    expect(robotsVerdict(robotsPolicyFromResponse(404, "x"), "/a").allowed).toBe(true);
    expect(robotsVerdict(robotsPolicyFromResponse(503, null), "/a")).toEqual({ allowed: false, rule: "robots_unreachable" });
    expect(robotsVerdict(robotsPolicyFromResponse(null, null), "/a").allowed).toBe(false);
    expect(robotsVerdict(robotsPolicyFromResponse(200, "User-agent: *\nDisallow: /z"), "/z").allowed).toBe(false);
  });
});

describe("HostGate: пауза і 1 сторінка на хост (юніт, віртуальний час)", () => {
  it("пауза < 1500 мс без fixture:true — виняток; дефолт = 1500", () => {
    expect(() => new HostGate(100)).toThrow(/fixture:true/);
    expect(() => new HostGate(0, { fixture: true })).not.toThrow();
    expect(new HostGate().minDelayMs).toBe(MIN_DELAY_MS);
  });
  it("між навігаціями одного хоста ≥ 1500 мс; різні хости незалежні; лічильник звернень", async () => {
    let t = 1_000_000;
    const g = new HostGate(1500, { now: () => t, sleep: async (ms) => void (t += ms) });
    await g.wait("https://a.test/1");
    await g.wait("https://a.test/2");
    t += 2000;
    await g.wait("https://a.test/3");
    await g.wait("https://b.test/1");
    const r = g.report();
    expect(r.per_host["a.test"]).toEqual({ navigations: 3, min_gap_ms: 1500 });
    expect(r.per_host["b.test"]).toEqual({ navigations: 1, min_gap_ms: null });
    expect(r.hits.filter((h) => h.host === "a.test").every((h) => h.gap_ms === null || h.gap_ms >= 1500)).toBe(true);
  });
  it("1 сторінка одночасно на хост (контроль: різні хости йдуть паралельно)", async () => {
    const g = new HostGate(0, { fixture: true });
    let cur = 0;
    let max = 0;
    const job = () => async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 15));
      cur--;
    };
    await Promise.all([1, 2, 3, 4].map((i) => g.run(`https://a.test/${i}`, job())));
    expect(max).toBe(1);
    expect(g.maxConcurrent).toBe(1);
    cur = 0;
    max = 0;
    const g2 = new HostGate(0, { fixture: true });
    await Promise.all([g2.run("https://a.test/", job()), g2.run("https://b.test/", job())]);
    expect(max).toBe(2);
  });
});

describe("≤ 5 аудитів на сайт за добу (персистентний лічильник)", () => {
  it("6-й відмовлено без інкремента; інша доба й інший хост — з нуля; переживає перезапуск (новий екземпляр)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sl-daily-"));
    try {
      const file = path.join(dir, "data/audit-counter.json");
      let day = "2026-09-29T10:00:00Z";
      const mk = () => new DailyAuditLimiter(file, 5, () => new Date(day));
      for (let i = 1; i <= 5; i++) expect(mk().tryRecord("shop.example")).toMatchObject({ allowed: true, count: i });
      expect(mk().tryRecord("shop.example")).toMatchObject({ allowed: false, count: 5 });
      expect(mk().tryRecord("shop.example")).toMatchObject({ allowed: false, count: 5 });
      expect(mk().tryRecord("other.example")).toMatchObject({ allowed: true, count: 1 });
      day = "2026-09-30T00:00:01Z";
      expect(mk().tryRecord("shop.example")).toMatchObject({ allowed: true, count: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const base = (o: Partial<BotInput>): BotInput => ({ http_status: 200, headers: {}, title: "Магазин", visible_text: "x".repeat(4000), markers: [], ...o });
describe("розпізнавання бот-захисту (юніт)", () => {
  it("Cloudflare challenge (cf-mitigated, DOM), 403/429/503, капча на порожній сторінці, бот-стіна за заголовком", () => {
    expect(detectBotProtection(base({ http_status: 403, headers: { "cf-mitigated": "challenge", "cf-ray": "1", server: "cloudflare" }, title: "Just a moment...", visible_text: "Checking your browser", markers: ["cf_challenge_dom"] }))).toMatchObject({ blocked: true, kind: "cloudflare_challenge" });
    expect(detectBotProtection(base({ http_status: 200, markers: ["cf_challenge_platform"], visible_text: "x" })).kind).toBe("cloudflare_challenge");
    expect(detectBotProtection(base({ http_status: 403 })).kind).toBe("http_403");
    expect(detectBotProtection(base({ http_status: 429, headers: { "retry-after": "60" } })).signals).toContain("header:retry-after=60");
    expect(detectBotProtection(base({ http_status: 503 })).kind).toBe("http_503");
    expect(detectBotProtection(base({ markers: ["recaptcha"], visible_text: "Verify you are human", title: "Перевірка" })).kind).toBe("captcha");
    expect(detectBotProtection(base({ title: "Attention Required! | Cloudflare", visible_text: "Sorry, you have been blocked" })).kind).toBe("bot_wall");
  });
  it("негативи: нормальна сторінка, довга сторінка з reCAPTCHA-віджетом, слово «captcha» у довгому тексті, cf-ray на 200", () => {
    expect(detectBotProtection(base({})).blocked).toBe(false);
    expect(detectBotProtection(base({ markers: ["recaptcha"] })).blocked).toBe(false);
    expect(detectBotProtection(base({ visible_text: "Ми захищаємо форму від спаму. captcha ".repeat(200) })).blocked).toBe(false);
    expect(detectBotProtection(base({ headers: { "cf-ray": "1", server: "cloudflare" } })).blocked).toBe(false);
  });
});

describe("інтеграція: robots.txt, чесний UA, пауза, бот-захист на fixtures/bot", () => {
  let sb: SecureBrowser;
  const PORT = 4330;
  const dirs: string[] = [];
  const run = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "sl-bot-"));
    dirs.push(d);
    return d;
  };
  beforeAll(async () => {
    sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [`http://127.0.0.1:${PORT}`] });
  });
  afterAll(async () => {
    await sb?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("robots.txt: Disallow → сторінка не береться (0 запитів до сервера), Allow довшим правилом → береться; UA чесний; robots — через захищений браузер", async () => {
    const srv = await startBotFixture({ port: PORT });
    try {
      const runDir = run();
      const gate = new HostGate(250, { fixture: true });
      const r = await auditSite({ secure: sb, seedUrl: srv.origin + "/", runDir, writeShots: false, tiles: false, ethics: { userAgent: HONEST_USER_AGENT, gate, enforceRobots: true } });
      const paths = srv.log.map((l) => l.path);
      expect(paths).toContain("/robots.txt");
      expect(paths).not.toContain("/private/secret");
      expect(paths).toContain("/private/open");
      expect(r.robots).toMatchObject({ status: 200, fetch: "ok" });
      const dis = r.errors.filter((e) => e.code === "robots_disallow");
      expect(dis.map((e) => new URL(e.page_url).pathname)).toEqual(["/private/secret"]);
      expect(dis[0]!.signals[0]).toBe("Disallow: /private/");
      const robotsArt = JSON.parse(readFileSync(path.join(runDir, "robots.json"), "utf8"));
      expect(robotsArt.disallowed_skipped).toHaveLength(1);
      // чесний UA і на robots.txt, і на сторінках
      expect(srv.log.length).toBeGreaterThan(3);
      for (const l of srv.log) expect(l.user_agent, l.path).toContain("SiteLensBot");
      expect(HONEST_USER_AGENT).toMatch(/SiteLensBot\/\d.*contact:/);
      // пауза й лічильник звернень: артефакт
      const hits = JSON.parse(readFileSync(path.join(runDir, "host-hits.json"), "utf8"));
      const host = new URL(srv.origin).host;
      expect(hits.per_host[host].navigations).toBeGreaterThan(8);
      expect(hits.per_host[host].min_gap_ms).toBeGreaterThanOrEqual(250);
      expect(hits.max_concurrent_pages_per_host).toBe(1);
    } finally {
      await srv.close();
    }
  }, 240_000);

  it("контроль: без enforceRobots той самий crawl бере /private/secret (перевірка вміє впасти)", async () => {
    const srv = await startBotFixture({ port: PORT });
    try {
      await auditSite({ secure: sb, seedUrl: srv.origin + "/", runDir: run(), writeShots: false, tiles: false, ethics: { userAgent: HONEST_USER_AGENT, gate: new HostGate(0, { fixture: true }), enforceRobots: false } });
      expect(srv.log.map((l) => l.path)).toContain("/private/secret");
      expect(srv.log.map((l) => l.path)).not.toContain("/robots.txt");
    } finally {
      await srv.close();
    }
  }, 240_000);

  it("бот-захист: cf/captcha/429/503/403 → помилка сторінки з ознаками, 0 доказів і 0 знахідок на них; нормальна сторінка з reCAPTCHA-віджетом — не помилка", async () => {
    const srv = await startBotFixture({ port: PORT, robots: false });
    try {
      const runDir = run();
      const r = await auditSite({ secure: sb, seedUrl: srv.origin + "/", runDir, writeShots: false, tiles: false, minDelayMs: 0 });
      const byPath = new Map(r.errors.filter((e) => e.code === "bot_protection").map((e) => [new URL(e.page_url).pathname, e]));
      expect(byPath.get("/cf")).toMatchObject({ kind: "cloudflare_challenge", http_status: 403 });
      expect(byPath.get("/cf")!.signals).toEqual(expect.arrayContaining(["http_status:403", "header:cf-mitigated=challenge", "header:cf-ray", "dom:cf_challenge_dom", "title:Just a moment..."]));
      expect(byPath.get("/captcha")).toMatchObject({ kind: "captcha", http_status: 200 });
      expect(byPath.get("/rate")).toMatchObject({ kind: "http_429" });
      expect(byPath.get("/rate")!.signals).toContain("header:retry-after=120");
      expect(byPath.get("/unavail")).toMatchObject({ kind: "http_503" });
      expect(byPath.get("/forbidden")).toMatchObject({ kind: "http_403" });
      expect([...byPath.keys()].sort()).toEqual(["/captcha", "/cf", "/forbidden", "/rate", "/unavail"]);
      expect(byPath.has("/contact-ok")).toBe(false);
      expect(r.site_error).toBeNull();
      const blockedPaths = new Set([...byPath.keys()]);
      expect(r.evidence.filter((e) => blockedPaths.has(e.page_path))).toHaveLength(0);
      for (const c of r.captures.filter((p) => blockedPaths.has(p.path))) expect(c.page_type).toBe("unknown");
      expect(r.coverage.filter((c) => c.reason.startsWith("bot_protection:")).length).toBe(3 * 5);
      expect(r.captures.some((p) => p.path === "/contact-ok" && !p.page_error)).toBe(true);
      expect(JSON.parse(readFileSync(path.join(runDir, "errors.json"), "utf8")).page_errors).toHaveLength(5);
    } finally {
      await srv.close();
    }
  }, 240_000);

  it("сайт цілком за бот-захистом: seed → site_error, 0 доказів, 0 знахідок, посилання не збираються", async () => {
    const srv = await startBotFixture({ port: PORT, robots: false });
    try {
      const r = await auditSite({ secure: sb, seedUrl: srv.origin + "/cf", runDir: run(), writeShots: false, tiles: false, minDelayMs: 0 });
      expect(r.site_error).toMatchObject({ code: "bot_protection", kind: "cloudflare_challenge" });
      expect(r.evidence).toHaveLength(0);
      expect(r.findings).toHaveLength(0);
      expect(r.captures).toHaveLength(1);
    } finally {
      await srv.close();
    }
  }, 240_000);

  it("robots Disallow на seed → site_error robots_disallow, жодної навігації до seed", async () => {
    const srv = await startBotFixture({ port: PORT });
    try {
      const r = await auditSite({ secure: sb, seedUrl: srv.origin + "/private/secret", runDir: run(), writeShots: false, tiles: false, ethics: { userAgent: HONEST_USER_AGENT, gate: new HostGate(0, { fixture: true }), enforceRobots: true } });
      expect(r.site_error).toMatchObject({ code: "robots_disallow" });
      expect(r.captures).toHaveLength(0);
      expect(srv.log.map((l) => l.path)).toEqual(["/robots.txt"]);
    } finally {
      await srv.close();
    }
  }, 120_000);

  it("prod-режим без ethics — виняток (пауза/robots/UA не можна забути)", async () => {
    const prod = await secureLaunch({ mode: "prod" });
    try {
      await expect(auditSite({ secure: prod, seedUrl: "https://example.com/", runDir: run(), writeShots: false, tiles: false })).rejects.toThrow(/ethics/);
    } finally {
      await prod.close();
    }
  }, 60_000);
});
