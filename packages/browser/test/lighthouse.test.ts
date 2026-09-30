/**
 * Lighthouse за egress-проксі (S1b, A4, V14): канарка через Lighthouse = 0 з контролями, env/пісочниця, ізоляція збою,
 * прогін на фікстурі shop → BENCHMARKED Evidence. Без DNS і зовнішньої мережі: `attacker.test` → мок-резолвер →
 * 93.184.216.34 → ін'єктований дайлер → локальна сторінка атакувальника.
 * Артефакти: planning/qa/artifacts/sprint-1b/lighthouse/.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ChromeLauncher from "chrome-launcher";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startShop } from "../../../fixtures/shop/server.js";
import { captureSlice } from "../src/capture.js";
import {
  lighthouseChromeFlags,
  runLighthouseIsolated,
  runLighthouseRaw,
  strayChromeProcesses,
  type LighthouseFn,
  type LighthouseRunResult,
} from "../src/lighthouse/run-lighthouse.js";
import { startEgressProxy, type Dialer, type ProxyDecision, type Resolver } from "../src/net/egress-proxy.js";
import { serveDir } from "../src/static-server.js";
import { buildBrowserEnv, secureLaunch } from "../src/secure-launch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ART = path.join(ROOT, "planning/qa/artifacts/sprint-1b/lighthouse");
const CANARY_HOST = "127.0.0.2";
const CANARY_PORT = 4197; // окремий порт: інші тест-файли тримають 4199/4198 паралельно
const FAKE_PUBLIC = "93.184.216.34";
const FAKE = { SITELENS_FAKE_LLM_KEY: "sk-fake-lh-7f3a9c", SITELENS_FAKE_DB_URL: "postgres://u:fake-lh-pw@db/x" };

const PROBE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>lighthouse probe</title><main><h1>probe</h1>
<img src="http://${CANARY_HOST}:${CANARY_PORT}/lh-img" alt="x" width="10" height="10">
<link rel="stylesheet" href="http://${CANARY_HOST}:${CANARY_PORT}/lh-css">
<iframe title="a" src="http://${CANARY_HOST}:${CANARY_PORT}/lh-iframe"></iframe>
<iframe title="b" src="/redir-canary"></iframe>
<img src="http://2130706434:${CANARY_PORT}/lh-decimal" alt="y" width="10" height="10">
</main><script>
fetch("http://${CANARY_HOST}:${CANARY_PORT}/lh-fetch", { mode: "no-cors" }).catch(() => {});
fetch("http://169.254.169.254/latest/meta-data/", { mode: "no-cors" }).catch(() => {});
navigator.sendBeacon && navigator.sendBeacon("http://${CANARY_HOST}:${CANARY_PORT}/lh-beacon", "x");
try { new WebSocket("ws://${CANARY_HOST}:${CANARY_PORT}/lh-ws"); } catch (e) {}
</script></html>`;

interface Hit { ts: string; method: string; url: string }
const canaryHits: Hit[] = [];
const attackerHits: Hit[] = [];
let canary: http.Server;
let attacker: http.Server;
let attackerPort = 0;
const tmp: string[] = [];
const saved: Record<string, string | undefined> = {};

const resolver: Resolver = async (h) => {
  if (h === "attacker.test") return [{ address: FAKE_PUBLIC, family: 4 }];
  throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
};
const dial: Dialer = (ip, port) => (ip === FAKE_PUBLIC ? net.connect(attackerPort, "127.0.0.1") : net.connect({ host: ip, port }));

beforeAll(async () => {
  for (const [k, v] of Object.entries(FAKE)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  canary = http.createServer((req, res) => {
    canaryHits.push({ ts: new Date().toISOString(), method: req.method ?? "?", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "text/plain" }).end("canary");
  });
  canary.on("upgrade", (req, sock) => {
    canaryHits.push({ ts: new Date().toISOString(), method: "UPGRADE", url: req.url ?? "" });
    sock.destroy();
  });
  await new Promise<void>((r, j) => {
    canary.once("error", j);
    canary.listen(CANARY_PORT, CANARY_HOST, r);
  });
  attacker = http.createServer((req, res) => {
    attackerHits.push({ ts: new Date().toISOString(), method: req.method ?? "?", url: req.url ?? "" });
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/probe.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PROBE_HTML);
    if (p === "/redir-canary") return void res.writeHead(302, { location: `http://${CANARY_HOST}:${CANARY_PORT}/lh-redirect` }).end();
    res.writeHead(404, { "content-type": "text/plain" }).end("nf");
  });
  await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
  attackerPort = (attacker.address() as AddressInfo).port;
  mkdirSync(ART, { recursive: true });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  canary.closeAllConnections();
  attacker.closeAllConnections();
  await new Promise((r) => canary.close(r));
  await new Promise((r) => attacker.close(r));
});

function save(name: string, data: unknown) {
  writeFileSync(path.join(ART, name), JSON.stringify(data, null, 2) + "\n");
}
const brief = (l: ProxyDecision[]) => l.map((x) => ({ via: x.via, method: x.method, host: x.host, port: x.port, path: x.path, decision: x.decision, reason: x.reason, connected_ip: x.connected_ip, peer_pid: x.peer_pid }));
const summary = (r: LighthouseRunResult) => ({ ok: r.ok, error: r.error, url: r.url, form_factor: r.form_factor, duration_ms: r.duration_ms, lighthouse_version: r.lighthouse_version, runtime_error: r.runtime_error, scores: r.scores, lhr_path: r.lhr_path, proxy_auth_mode: r.proxy_auth_mode, chrome: { pid: r.chrome.pid, alive_after: r.chrome.alive_after, flags: r.chrome.flags, env_keys: r.chrome.env ? Object.keys(r.chrome.env) : null, processes: r.chrome.processes } });

/** Обгортка CHROME_PATH: записує env, з яким процес Chrome реально стартував, і exec-ить Chromium Playwright. */
function envDumpingChrome(): { chromePath: string; dump: string } {
  const d = mkdtempSync(path.join(os.tmpdir(), "sl-lhwrap-"));
  tmp.push(d);
  const dump = path.join(d, "env.txt");
  const script = path.join(d, "chrome-wrapper.sh");
  writeFileSync(script, `#!/bin/sh\nenv > "${dump}"\nexec "${chromium.executablePath()}" "$@"\n`);
  chmodSync(script, 0o755);
  return { chromePath: script, dump };
}
const secretLeaks = (envText: string) => Object.values(FAKE).filter((v) => envText.includes(v)).length;

describe("Lighthouse за проксі: канарка (V14)", () => {
  it("prod: Lighthouse на probe-сторінці → канарка 0, лог проксі містить запити Lighthouse, env чистий, пісочниця, Evidence BENCHMARKED", async () => {
    const start = canaryHits.length;
    const attStart = attackerHits.length;
    const w = envDumpingChrome();
    const outDir = path.join(ART, "probe");
    const r = await runLighthouseIsolated({ url: "http://attacker.test/probe.html", mode: "prod", resolver, dial, outDir, chromePath: w.chromePath, secretsProbe: Object.values(FAKE), timeoutMs: 60_000 });
    await new Promise((res) => setTimeout(res, 300));
    const hits = canaryHits.slice(start);
    const envText = readFileSync(w.dump, "utf8");
    const envKeys = envText.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
    save("lh-probe-prod.json", { scenario: "Lighthouse prod за проксі, attacker.test → мок-резолвер", ...summary(r), canary: `${CANARY_HOST}:${CANARY_PORT}`, canary_hits: hits.length, hits, attacker_requests: attackerHits.slice(attStart), chrome_start_env_keys: envKeys, chrome_start_env_secret_hits: secretLeaks(envText), proxy_decisions: brief(r.proxy_log), evidence: r.evidence });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(hits).toHaveLength(0);
    // лог проксі містить запити Lighthouse до сторінки (дозволено, TCP до перевіреної IP, клієнт — нащадок worker)
    const pageAllow = r.proxy_log.filter((l) => l.host === "attacker.test" && l.decision === "allow");
    expect(pageAllow.length).toBeGreaterThanOrEqual(1);
    expect(pageAllow.every((l) => l.connected_ip === FAKE_PUBLIC && typeof l.peer_pid === "number")).toBe(true);
    expect(attackerHits.slice(attStart).map((h) => h.url)).toContain("/probe.html");
    const denied = new Set(r.proxy_log.filter((l) => l.decision === "deny").map((l) => l.host));
    for (const h of [CANARY_HOST, "169.254.169.254"]) expect(denied.has(h), h).toBe(true);
    // env і пісочниця Chrome Lighthouse
    expect(secretLeaks(envText)).toBe(0);
    expect(envKeys.filter((k) => !["PATH", "LANG", "LC_ALL", "TZ", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PWD", "SHLVL", "_"].includes(k))).toEqual([]);
    expect(r.chrome.flags).toEqual(expect.arrayContaining([expect.stringMatching(/^--proxy-server=/), "--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]));
    expect(r.chrome.flags.some((f) => /--no-sandbox|--disable-setuid-sandbox/.test(f))).toBe(false);
    expect(r.chrome.processes.length).toBeGreaterThan(2);
    expect(r.chrome.processes.some((p) => p.no_sandbox)).toBe(false);
    expect(r.chrome.processes.some((p) => p.type === "renderer" && p.seccomp === 2)).toBe(true);
    expect(r.chrome.alive_after).toBe(false);
    // Evidence §23
    expect(r.evidence.map((e) => e.detector_id).sort()).toEqual(["lighthouse:accessibility", "lighthouse:performance"]);
    for (const e of r.evidence) {
      expect(e.source_class).toBe("BENCHMARKED");
      expect(e.type).toBe("lighthouse");
      expect(existsSync(path.join(outDir, e.artifact_reference))).toBe(true);
    }
  });

  it("контроль (а): той самий Chrome/Lighthouse БЕЗ прапорців проксі → канарка отримує запити", async () => {
    const start = canaryHits.length;
    const d = mkdtempSync(path.join(os.tmpdir(), "sl-lhctl-"));
    tmp.push(d);
    for (const sub of ["home/.config", "home/.cache", "tmp", "profile"]) mkdirSync(path.join(d, sub), { recursive: true });
    const flags = lighthouseChromeFlags("http://unused").filter((f) => !f.startsWith("--proxy"));
    const raw = await runLighthouseRaw({ url: `http://127.0.0.1:${attackerPort}/probe.html`, flags, env: buildBrowserEnv(d), userDataDir: path.join(d, "profile"), formFactor: "desktop", timeoutMs: 60_000 });
    await new Promise((res) => setTimeout(res, 300));
    const hits = canaryHits.slice(start);
    save("lh-control-no-proxy.json", { scenario: "(а) контроль: Lighthouse без --proxy-server/--proxy-bypass-list", lhr_ok: !!raw.lhr && !raw.lhr.runtimeError, canary_hits: hits.length, hits });
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.url))).toEqual(expect.objectContaining({}));
    expect(hits.map((h) => h.url)).toEqual(expect.arrayContaining(["/lh-img", "/lh-iframe"]));
  });

  it("контроль (в): проксі є, але без <-loopback> → Chrome Lighthouse іде на канарку напряму", async () => {
    const start = canaryHits.length;
    const proxy = await startEgressProxy({ mode: { kind: "prod" }, resolver, dial });
    const d = mkdtempSync(path.join(os.tmpdir(), "sl-lhctl-"));
    tmp.push(d);
    for (const sub of ["home/.config", "home/.cache", "tmp", "profile"]) mkdirSync(path.join(d, sub), { recursive: true });
    try {
      const flags = lighthouseChromeFlags(proxy.url).filter((f) => !f.startsWith("--proxy-bypass-list"));
      await runLighthouseRaw({ url: "http://attacker.test/probe.html", flags, env: buildBrowserEnv(d), userDataDir: path.join(d, "profile"), formFactor: "desktop", timeoutMs: 60_000 });
    } finally {
      await proxy.close();
    }
    await new Promise((res) => setTimeout(res, 300));
    const hits = canaryHits.slice(start);
    save("lh-control-no-loopback-flag.json", { scenario: "(в) контроль: Lighthouse за проксі без <-loopback>", canary_hits: hits.length, hits, proxy_decisions: brief(proxy.log) });
    expect(hits.length).toBeGreaterThan(0);
    expect(proxy.log.some((l) => l.host === "attacker.test" && l.decision === "allow")).toBe(true);
  });

  it("контроль env: chrome-launcher за замовчуванням передає весь process.env (фейкові секрети) і --disable-setuid-sandbox", async () => {
    const w = envDumpingChrome();
    const d = mkdtempSync(path.join(os.tmpdir(), "sl-lhctl-"));
    tmp.push(d);
    const chrome = await ChromeLauncher.launch({ chromePath: w.chromePath, chromeFlags: ["--headless=new"], userDataDir: d, logLevel: "silent", handleSIGINT: false });
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${chrome.pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } finally {
      chrome.kill();
    }
    const envText = readFileSync(w.dump, "utf8");
    save("lh-control-default-env.json", { scenario: "контроль: chrome-launcher з дефолтними envVars і прапорцями", secret_hits: secretLeaks(envText), has_disable_setuid_sandbox: cmd.includes("--disable-setuid-sandbox") });
    expect(secretLeaks(envText)).toBe(Object.keys(FAKE).length);
    expect(cmd).toContain("--disable-setuid-sandbox");
  });
});

describe("ізоляція збою Lighthouse", () => {
  it("зламаний Lighthouse (виняток / зависання / поганий CHROME_PATH) → ok:false без винятку, Chrome прибрано; паралельне захоплення SecureBrowser — 3 Evidence", async () => {
    const slice = await serveDir(path.join(ROOT, "fixtures/slice"));
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [slice.origin] });
    const outDir = mkdtempSync(path.join(os.tmpdir(), "sl-lh-iso-"));
    tmp.push(outDir);
    const throwing: LighthouseFn = (async () => {
      throw new Error("штучно зламаний Lighthouse");
    }) as unknown as LighthouseFn;
    const hanging: LighthouseFn = (() => new Promise(() => {})) as unknown as LighthouseFn;
    const garbage: LighthouseFn = (async () => ({ lhr: { lighthouseVersion: "x", categories: {}, audits: {} } })) as unknown as LighthouseFn;
    try {
      const [cap, a, b, c, g] = await Promise.all([
        captureSlice({ url: `${slice.origin}/defective.html`, outDir, secure: sb }),
        runLighthouseIsolated({ url: `${slice.origin}/defective.html`, mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [slice.origin], outDir, lighthouseImpl: throwing }),
        runLighthouseIsolated({ url: `${slice.origin}/defective.html`, mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [slice.origin], outDir, lighthouseImpl: hanging, timeoutMs: 4000 }),
        runLighthouseIsolated({ url: `${slice.origin}/defective.html`, mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [slice.origin], outDir, chromePath: "/nonexistent/chrome" }),
        runLighthouseIsolated({ url: `${slice.origin}/defective.html`, mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [slice.origin], outDir, lighthouseImpl: garbage }),
      ]);
      const stray = await strayChromeProcesses();
      save("lh-isolation.json", {
        capture_evidence: cap.evidence.length,
        throwing: { ok: a.ok, error: a.error, alive_after: a.chrome.alive_after },
        hanging: { ok: b.ok, error: b.error, alive_after: b.chrome.alive_after, duration_ms: b.duration_ms },
        bad_chrome_path: { ok: c.ok, error: c.error },
        empty_lhr: { ok: g.ok, error: g.error, evidence: g.evidence.length },
        stray_chrome_processes: stray,
      });
      expect(cap.evidence).toHaveLength(3);
      for (const r of [a, b, c, g]) {
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(r.evidence).toEqual([]);
        expect(r.chrome.alive_after).toBe(false);
      }
      expect(a.error).toMatch(/штучно зламаний/);
      expect(b.error).toMatch(/timeout/);
      expect(b.duration_ms).toBeLessThan(15_000);
      expect(stray).toEqual([]);
    } finally {
      await sb.close();
      await slice.close();
    }
  });
});

describe("фікстура shop: Lighthouse за проксі → BENCHMARKED Evidence", () => {
  it("fixture-режим з точковим allow-list: desktop + mobile; prod-режим (без allow-list) → фікстура заблокована", async () => {
    const shop = await startShop();
    const outDir = path.join(ART, "shop");
    try {
      const results: LighthouseRunResult[] = [];
      for (const ff of ["desktop", "mobile"] as const) {
        results.push(await runLighthouseIsolated({ url: `${shop.origin}/`, formFactor: ff, mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [shop.origin], outDir, timeoutMs: 90_000 }));
      }
      const before = shop.log.length;
      const prod = await runLighthouseIsolated({ url: `${shop.origin}/`, mode: "prod", outDir: mkdtempSync(path.join(os.tmpdir(), "sl-lh-prod-")), timeoutMs: 60_000 });
      const shopReqsInProd = shop.log.length - before;
      const port = Number(new URL(shop.origin).port);
      save("lh-shop.json", {
        runs: results.map((r) => ({ ...summary(r), proxy_decisions: brief(r.proxy_log), evidence: r.evidence })),
        prod_without_allowlist: { ...summary(prod), proxy_decisions: brief(prod.proxy_log), shop_requests: shopReqsInProd },
        shop_request_log_sample: shop.log.slice(0, 20),
      });
      save("evidence-shop.json", results.flatMap((r) => r.evidence));
      for (const r of results) {
        expect(r.error).toBeNull();
        expect(r.ok).toBe(true);
        expect(r.evidence).toHaveLength(2);
        for (const e of r.evidence) {
          expect(e.source_class).toBe("BENCHMARKED");
          expect(e.viewport).toBe(r.form_factor);
          expect(existsSync(path.join(outDir, e.artifact_reference))).toBe(true);
          expect(typeof (e.data as { score: number }).score).toBe("number");
        }
        expect(r.proxy_log.some((l) => l.decision === "allow" && l.port === port && typeof l.peer_pid === "number")).toBe(true);
      }
      expect(prod.ok).toBe(false);
      expect(prod.evidence).toEqual([]);
      expect(prod.proxy_log.some((l) => l.decision === "deny" && l.port === port)).toBe(true);
      expect(shopReqsInProd).toBe(0);
    } finally {
      await shop.close();
    }
  }, 240_000);
});
