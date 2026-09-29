/**
 * Наскрізні перевірки захищеного Chromium (G0-3, G0-4, G0-11): канарка, не-GET, env/пісочниця.
 * Кожна перевірка спершу показана на поганому вході (контроль «уміє впасти»), потім PASS.
 * Без DNS і без зовнішньої мережі: «attacker.test» → мок-резолвер → публічна IP 93.184.216.34, а ін'єктований дайлер
 * з'єднує ЛИШЕ цю IP з локальним сервером атакувальника («симульований інтернет»); будь-яку іншу IP дайлер набирає
 * по-справжньому — тож якби проксі пропустив 127.0.0.2, канарка отримала б запит.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type Dialer, type ProxyDecision, type Resolver } from "../src/net/egress-proxy.js";
import { captureSlice } from "../src/capture.js";
import { auditSite } from "../src/audit/run-site.js";
import { serveDir } from "../src/static-server.js";
import {
  applyContextGuards,
  buildBrowserEnv,
  buildLaunchOptions,
  SECURE_CONTEXT_DEFAULTS,
  secureLaunch,
  type BlockedRequest,
} from "../src/secure-launch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ART = path.join(ROOT, "planning/qa/artifacts/sprint-1a/canary");
const CANARY_HOST = "127.0.0.2";
const CANARY_PORT = 4199;
const FAKE_PUBLIC = "93.184.216.34";

interface Hit { ts: string; method: string; url: string; host: string | undefined; upgrade?: boolean }

async function listen(host: string, port: number, handler: http.RequestListener, onUpgrade?: (req: http.IncomingMessage) => void) {
  const server = http.createServer(handler);
  if (onUpgrade) server.on("upgrade", (req, sock) => { onUpgrade(req); sock.destroy(); });
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, host, r); });
  return { server, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const ATTACK_HTML = `<!doctype html><meta charset="utf-8"><title>attack</title>
<h1 id="loaded">attack page</h1>
<img src="http://${CANARY_HOST}:${CANARY_PORT}/img">
<link rel="stylesheet" href="http://${CANARY_HOST}:${CANARY_PORT}/css">
<iframe src="http://${CANARY_HOST}:${CANARY_PORT}/iframe"></iframe>
<iframe src="/redir-canary"></iframe>
<iframe src="/redir-private"></iframe>
<img src="http://2130706434:${CANARY_PORT}/decimal-img">
<script>
  const opts = { mode: "no-cors" };
  fetch("http://${CANARY_HOST}:${CANARY_PORT}/fetch", opts).catch(() => {});
  fetch("http://169.254.169.254/latest/meta-data/", opts).catch(() => {});
  fetch("http://metadata.google.internal/computeMetadata/v1/", opts).catch(() => {});
  fetch("http://[::ffff:127.0.0.2]:${CANARY_PORT}/mapped", opts).catch(() => {});
  // popup — після load: у headless Chromium popup того ж сайту, що й iframe, інколи блокує load iframe (не безпекове)
  addEventListener("load", () => setTimeout(() => { try { window.open("http://${CANARY_HOST}:${CANARY_PORT}/popup"); } catch (e) {} }, 50));
</script>`;

const FORMS_HTML = `<!doctype html><meta charset="utf-8"><title>forms</title>
<form id="f" method="post" action="/submit"><input name="q" value="1"><button id="send" type="submit">Надіслати</button></form>
<button id="cart" onclick="fetch('/cart/add', {method: 'POST', body: 'id=1'}).catch(() => {})">В кошик</button>`;

let canary: Awaited<ReturnType<typeof listen>>;
let attacker: Awaited<ReturnType<typeof listen>>;
const canaryHits: Hit[] = [];
const attackerHits: Hit[] = [];

const resolver: Resolver = async (h) => {
  if (h === "attacker.test") return [{ address: FAKE_PUBLIC, family: 4 }];
  throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
};
const dial: Dialer = (ip, port) => (ip === FAKE_PUBLIC ? net.connect(attacker.port, "127.0.0.1") : net.connect({ host: ip, port }));

beforeAll(async () => {
  canary = await listen(CANARY_HOST, CANARY_PORT, (req, res) => {
    canaryHits.push({ ts: new Date().toISOString(), method: req.method ?? "?", url: req.url ?? "", host: req.headers.host });
    res.writeHead(200, { "content-type": "text/plain" }).end("canary");
  });
  attacker = await listen("127.0.0.1", 0, (req, res) => {
    attackerHits.push({ ts: new Date().toISOString(), method: req.method ?? "?", url: req.url ?? "", host: req.headers.host });
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/attack.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ATTACK_HTML);
    if (p === "/forms.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORMS_HTML);
    if (p === "/redir-canary") return void res.writeHead(302, { location: `http://${CANARY_HOST}:${CANARY_PORT}/redirect` }).end();
    if (p === "/redir-private") return void res.writeHead(302, { location: "http://10.0.0.1/admin" }).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  }, (req) => attackerHits.push({ ts: new Date().toISOString(), method: req.method ?? "?", url: req.url ?? "", host: req.headers.host, upgrade: true }));
  mkdirSync(ART, { recursive: true });
});
afterAll(async () => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  await canary?.close();
  await attacker?.close();
});

async function visit(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1500);
  const loaded = (await page.locator("#loaded").count().catch(() => 0)) > 0;
  return { page, loaded };
}

const tmpRoots: string[] = [];
async function tmpBrowserEnv() {
  const d = mkdtempSync(path.join(os.tmpdir(), "sl-ctl-"));
  tmpRoots.push(d);
  for (const sub of ["home/.config", "home/.cache", "tmp"]) mkdirSync(path.join(d, sub), { recursive: true });
  return buildBrowserEnv(d);
}

function saveArtifact(name: string, data: unknown) {
  writeFileSync(path.join(ART, name), JSON.stringify(data, null, 2) + "\n");
}

const summarizeProxy = (log: ProxyDecision[]) => log.map((l) => ({ via: l.via, method: l.method, host: l.host, port: l.port, path: l.path, decision: l.decision, reason: l.reason, resolved: l.resolved.map((r) => r.ip), connected_ip: l.connected_ip }));

describe("канарка 127.0.0.2:4199 (G0-3, DEV-8)", () => {
  it("(а) контроль БЕЗ проксі: канарка отримує запити від img/css/iframe/fetch/redirect/popup", async () => {
    const start = canaryHits.length;
    const env = await tmpBrowserEnv();
    const base = buildLaunchOptions("unused", env);
    // Відрізняється від секʼюрного лише відсутністю --proxy-server/--proxy-bypass-list.
    const browser = await chromium.launch({ ...base, args: base.args!.filter((a) => !a.startsWith("--proxy")) });
    const blocked: BlockedRequest[] = [];
    try {
      const ctx = await browser.newContext(SECURE_CONTEXT_DEFAULTS);
      await applyContextGuards(ctx, blocked);
      const r = await visit(ctx, `http://127.0.0.1:${attacker.port}/attack.html`);
      expect(r.loaded).toBe(true);
      await ctx.close();
    } finally {
      await browser.close();
    }
    const hits = canaryHits.slice(start);
    saveArtifact("a-control-no-proxy.json", { scenario: "(а) без проксі, той самий Chromium/контекст", canary: `${CANARY_HOST}:${CANARY_PORT}`, canary_hits: hits.length, hits, layer2_blocked: blocked });
    expect(hits.length).toBeGreaterThan(0);
    const paths = new Set(hits.map((h) => h.url));
    for (const p of ["/img", "/iframe", "/fetch", "/redirect"]) expect(paths.has(p), p).toBe(true);
  });

  it("(б) prod-режим через проксі: 0 звернень до канарки, сторінка завантажилась, кожна спроба залогована як deny", async () => {
    const start = canaryHits.length;
    const attStart = attackerHits.length;
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    let loaded = false;
    try {
      const ctx = await sb.newContext();
      loaded = (await visit(ctx, "http://attacker.test/attack.html")).loaded;
      await ctx.close();
    } finally {
      await sb.close();
    }
    const hits = canaryHits.slice(start);
    const denies = sb.proxy.log.filter((l) => l.decision === "deny");
    saveArtifact("b-prod-proxy.json", {
      scenario: "(б) secureLaunch prod: attacker.test → мок-резолвер 93.184.216.34 → локальна сторінка атакувальника",
      page_loaded: loaded,
      attacker_requests: attackerHits.slice(attStart),
      canary_hits: hits.length,
      hits,
      proxy_decisions: summarizeProxy(sb.proxy.log),
      proxy_deny_count: denies.length,
      layer2_blocked: sb.blocked,
    });
    expect(loaded).toBe(true);
    expect(attackerHits.slice(attStart).map((h) => h.url)).toEqual(expect.arrayContaining(["/attack.html", "/redir-canary", "/redir-private"]));
    expect(hits).toHaveLength(0);
    const deniedHosts = new Set(denies.map((d) => `${d.host}`));
    for (const h of [CANARY_HOST, "169.254.169.254", "metadata.google.internal", "10.0.0.1"]) expect(deniedHosts.has(h), h).toBe(true);
    // mapped IPv6 канарки теж пішов на проксі і заблокований
    expect(denies.some((d) => d.host.includes("ffff"))).toBe(true);
  });

  it("(б2) fixture-режим: дозволено рівно origin фікстури, канарка на іншому loopback — 0", async () => {
    const start = canaryHits.length;
    const origin = `http://127.0.0.1:${attacker.port}`;
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
    let loaded = false;
    try {
      const ctx = await sb.newContext();
      loaded = (await visit(ctx, `${origin}/attack.html`)).loaded;
      await ctx.close();
    } finally {
      await sb.close();
    }
    const hits = canaryHits.slice(start);
    saveArtifact("b2-fixture-proxy.json", { scenario: "(б2) secureLaunch fixture, allow-list лише " + origin, page_loaded: loaded, canary_hits: hits.length, hits, proxy_decisions: summarizeProxy(sb.proxy.log), layer2_blocked: sb.blocked });
    expect(loaded).toBe(true);
    expect(hits).toHaveLength(0);
    expect(sb.proxy.log.some((l) => l.decision === "allow" && l.port === attacker.port)).toBe(true);
  });

  it("(в) контроль БЕЗ <-loopback>: Chromium обходить проксі для loopback → канарка отримує запит (прапорець потрібен)", async () => {
    const start = canaryHits.length;
    const proxy = await startEgressProxy({ mode: { kind: "prod" }, resolver, dial });
    const env = await tmpBrowserEnv();
    const base = buildLaunchOptions(proxy.url, env);
    const args = base.args!.filter((a) => !a.startsWith("--proxy-bypass-list"));
    expect(args.some((a) => a.startsWith("--proxy-server="))).toBe(true);
    const browser = await chromium.launch({ ...base, args });
    let loaded = false;
    const blocked: BlockedRequest[] = [];
    try {
      const ctx = await browser.newContext(SECURE_CONTEXT_DEFAULTS);
      await applyContextGuards(ctx, blocked);
      loaded = (await visit(ctx, "http://attacker.test/attack.html")).loaded;
      await ctx.close();
    } finally {
      await browser.close();
      await proxy.close();
    }
    const hits = canaryHits.slice(start);
    saveArtifact("c-control-no-loopback-flag.json", { scenario: "(в) проксі є, --proxy-bypass-list=<-loopback> прибрано", page_loaded: loaded, canary_hits: hits.length, hits, proxy_decisions: summarizeProxy(proxy.log), layer2_blocked: blocked });
    expect(loaded).toBe(true); // сторінка пройшла через проксі (не-loopback ім'я)
    expect(hits.length).toBeGreaterThan(0); // а loopback-канарка — повз проксі
    expect(proxy.log.some((l) => l.host === CANARY_HOST)).toBe(false);
  });
});

describe("шар 2: не-GET/HEAD і WebSocket (G0-11, DEV-12)", () => {
  async function runForms(ctx: BrowserContext) {
    const page = await ctx.newPage();
    await page.goto("http://attacker.test/forms.html", { waitUntil: "load" });
    await page.click("#cart");
    await page.evaluate(`fetch("/api/order", { method: "POST", body: "x" }).catch(() => {})`);
    await page.evaluate(`navigator.sendBeacon("/beacon", "data")`);
    await page.evaluate(`new Promise((r) => { const x = new XMLHttpRequest(); x.open("PUT", "/xhr"); x.onloadend = r; x.send("y"); })`);
    await page.evaluate(`fetch("/del", { method: "DELETE" }).catch(() => {})`);
    await page.evaluate(`new Promise((r) => { try { const w = new WebSocket("ws://" + location.host + "/ws"); w.onclose = r; w.onerror = r; setTimeout(r, 1500); } catch (e) { r(); } })`);
    await page.click("#send", { noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const ATTEMPTS = ["/cart/add", "/api/order", "/beacon", "/xhr", "/del", "/submit"];

  it("контроль: той самий проксі, контекст БЕЗ шару 2 → сервер отримує не-GET і WS upgrade (FAIL)", async () => {
    const start = attackerHits.length;
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    try {
      const ctx = await sb.browser.newContext(SECURE_CONTEXT_DEFAULTS); // навмисно без applyContextGuards
      await runForms(ctx);
      await ctx.close();
    } finally {
      await sb.close();
    }
    const got = attackerHits.slice(start);
    const nonGet = got.filter((h) => h.method !== "GET" && h.method !== "HEAD");
    saveArtifact("nonget-control-no-layer2.json", { server_requests: got, non_get_count: nonGet.length });
    expect(nonGet.length).toBeGreaterThanOrEqual(5);
    expect(got.some((h) => h.upgrade)).toBe(true);
  });

  it("захищений контекст: сервер 0 не-GET, 0 WS; лог блоків ≥1 на кожну спробу", async () => {
    const start = attackerHits.length;
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    try {
      const ctx = await sb.newContext();
      await runForms(ctx);
      await ctx.close();
    } finally {
      await sb.close();
    }
    const got = attackerHits.slice(start);
    const nonGet = got.filter((h) => h.method !== "GET" && h.method !== "HEAD");
    const perAttempt = Object.fromEntries(ATTEMPTS.map((p) => [p, sb.blocked.filter((b) => b.kind === "method" && new URL(b.url).pathname === p).length]));
    saveArtifact("nonget-secure.json", { server_requests: got, non_get_count: nonGet.length, blocked: sb.blocked, blocked_per_attempt: perAttempt });
    expect(got.map((h) => h.url)).toContain("/forms.html");
    expect(nonGet).toHaveLength(0);
    expect(got.some((h) => h.upgrade)).toBe(false);
    for (const p of ATTEMPTS) expect(perAttempt[p], p).toBeGreaterThanOrEqual(1);
    expect(sb.blocked.filter((b) => b.kind === "websocket").length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------------------------------------ env і пісочниця (G0-4, DEV-13)

function procOf(pid: number) {
  const read = (f: string) => { try { return readFileSync(`/proc/${pid}/${f}`); } catch { return null; } };
  // Chromium переписує title процесу (setproctitle): у дочірніх cmdline — один рядок через пробіли, тож шукаємо в склеєному.
  const cmd = read("cmdline")?.toString().split("\0").filter(Boolean) ?? [];
  const cmdStr = cmd.join(" ");
  const type = /--type=(\S+)/.exec(cmdStr)?.[1] ?? "browser";
  const noSandbox = /(^|\s)--no-sandbox(\s|$)/.test(cmdStr);
  const envRaw = read("environ");
  const env = envRaw === null ? null : envRaw.toString().split("\0").filter(Boolean);
  const status = read("status")?.toString() ?? "";
  const ppid = Number(/PPid:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const seccomp = Number(/Seccomp:\s+(\d+)/.exec(status)?.[1] ?? -1);
  return { pid, cmd, type, noSandbox, env, ppid, seccomp };
}
function chromiumTree(marker: string) {
  const all = readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((d) => procOf(Number(d)));
  const root = all.find((p) => p.type === "browser" && p.cmd.some((a) => a === marker));
  if (!root) return null;
  const tree = [root];
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!tree.includes(p) && tree.some((t) => t.pid === p.ppid)) { tree.push(p); grew = true; }
  }
  return { root, tree };
}

describe("середовище й пісочниця процесу Chromium (G0-4)", () => {
  const FAKE = { SL_FAKE_ANTHROPIC_API_KEY: `sk-ant-FAKE-${randomUUID()}`, DATABASE_URL: "postgres://u:FAKEPASS@x/db", ACCESS_TOKEN: `FAKE-${randomUUID()}` };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const [k, v] of Object.entries(FAKE)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterAll(() => { for (const k of Object.keys(FAKE)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const leaks = (env: string[] | null) => (env ?? []).filter((kv) => Object.values(FAKE).some((v) => kv.includes(v)));

  it("контроль: Chromium без очищення env і без пісочниці → фейковий ключ у /proc/<pid>/environ, --no-sandbox у cmdline (FAIL)", async () => {
    const marker = `--sl-test-marker=${randomUUID()}`;
    const browser: Browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: [marker] });
    try {
      const page = await browser.newPage();
      await page.setContent("<p>renderer</p>");
      const t = chromiumTree(marker);
      expect(t).not.toBeNull();
      const leaked = leaks(t!.root.env);
      saveArtifact("env-control-unsanitized.json", { pid: t!.root.pid, leaked_vars: leaked.map((kv) => kv.split("=")[0]), env_var_count: t!.root.env?.length, cmdline_has_no_sandbox: t!.root.noSandbox, processes: t!.tree.map((p) => ({ pid: p.pid, type: p.type, seccomp: p.seccomp, no_sandbox: p.noSandbox })) });
      expect(leaked.length).toBeGreaterThanOrEqual(3);
      expect(t!.root.noSandbox).toBe(true);
      // без пісочниці жоден renderer не під seccomp-bpf — предикат нижче вміє впасти
      expect(t!.tree.some((p) => p.type === "renderer")).toBe(true);
      expect(t!.tree.filter((p) => p.type === "renderer" && p.seccomp === 2)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("secureLaunch: 0 секретів у environ усіх читаних процесів дерева, env лише з білого списку, без --no-sandbox, seccomp-пісочниця активна", async () => {
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    try {
      const ctx = await sb.newContext();
      const page = await ctx.newPage();
      await page.goto("http://attacker.test/forms.html"); // щоб піднявся renderer
      const t = chromiumTree(`--proxy-server=${sb.proxy.url}`);
      expect(t).not.toBeNull();
      const readable = t!.tree.filter((p) => p.env !== null);
      const leaked = readable.flatMap((p) => leaks(p.env));
      const rootKeys = (t!.root.env ?? []).map((kv) => kv.split("=")[0]!);
      const allowedKeys = new Set(["PATH", "LANG", "LC_ALL", "TZ", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CHROME_DESKTOP", "GOOGLE_CRASHPAD_HANDLER_PID"]);
      const extra = rootKeys.filter((k) => !allowedKeys.has(k));
      const types = t!.tree.map((p) => ({ pid: p.pid, type: p.type, seccomp: p.seccomp, env_readable: p.env !== null, no_sandbox: p.noSandbox }));
      saveArtifact("env-secure.json", { root_pid: t!.root.pid, root_env_keys: rootKeys, non_allowlisted_keys: extra, leaked_count: leaked.length, processes: types, browser_env_passed: Object.keys(sb.browserEnv) });
      expect(t!.root.env).not.toBeNull();
      expect(leaked).toEqual([]);
      expect(extra).toEqual([]);
      expect(t!.tree.some((p) => p.noSandbox)).toBe(false);
      // renderer працює під seccomp-bpf (Seccomp: 2) — пісочниця справді ввімкнена, а не лише «прапорця немає»
      expect(types.some((p) => p.type === "renderer" && p.seccomp === 2)).toBe(true);
      await ctx.close();
    } finally {
      await sb.close();
    }
  });

  it("secureLaunch відмовляє в небезпечних опціях контексту і в fixtureOrigins у prod", async () => {
    await expect(secureLaunch({ mode: "prod", fixtureOrigins: ["http://127.0.0.1:1"] })).rejects.toThrow(/prod/);
    await expect(secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: ["http://10.0.0.1:80"] })).rejects.toThrow(/loopback/);
    // fixture без явного прапорця → виняток; з прапорцем, але порожній allow-list → виняток
    const prevFx = process.env.SITELENS_FIXTURE_MODE;
    delete process.env.SITELENS_FIXTURE_MODE;
    try {
      await expect(secureLaunch({ mode: "fixture", fixtureOrigins: ["http://127.0.0.1:1"] })).rejects.toThrow(/прапорець/);
      await expect(secureLaunch({ mode: "fixture", allowFixtureLoopback: true })).rejects.toThrow(/без allow-list/);
      await expect(secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [] })).rejects.toThrow(/без allow-list/);
    } finally {
      if (prevFx !== undefined) process.env.SITELENS_FIXTURE_MODE = prevFx;
    }
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    try {
      await expect(sb.newContext({ acceptDownloads: true })).rejects.toThrow(/acceptDownloads/);
      await expect(sb.newContext({ serviceWorkers: "allow" })).rejects.toThrow(/serviceWorkers/);
      await expect(sb.newContext({ proxy: { server: "http://1.2.3.4:1" } })).rejects.toThrow(/proxy/);
    } finally {
      await sb.close();
    }
  });
});

describe("інтеграція: captureSlice/auditSite лише через SecureBrowser", () => {
  it("defective.html → ті самі 3 Evidence, що й у slice-тесті; сирий Browser → помилка типу і runtime-виняток", async () => {
    const srv = await serveDir(path.join(ROOT, "fixtures/slice"));
    const out = mkdtempSync(path.join(os.tmpdir(), "sl-cap-"));
    tmpRoots.push(out);
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [srv.origin] });
    try {
      const r = await captureSlice({ url: `${srv.origin}/defective.html`, outDir: out, secure: sb });
      expect(r.evidence).toHaveLength(3);
      expect(srv.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
      // @ts-expect-error сирий Browser не є SecureBrowser
      await expect(captureSlice({ url: `${srv.origin}/defective.html`, outDir: out, secure: sb.browser })).rejects.toThrow(/SecureBrowser/);
      // @ts-expect-error сирий Browser не є SecureBrowser
      await expect(auditSite({ secure: sb.browser, seedUrl: `${srv.origin}/`, runDir: out, writeShots: false, tiles: false })).rejects.toThrow(/SecureBrowser/);
    } finally {
      await sb.close();
      await srv.close();
    }
  });
});
