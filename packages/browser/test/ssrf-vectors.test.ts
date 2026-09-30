/**
 * S1b: повний набір SSRF-векторів (planning/security/ssrf-vectors.md) наскрізно через справжній Chromium.
 *
 * Одна probe-сторінка атакувальника містить УСІ браузерні вектори; кожен б'є в канарку з унікальним шляхом `/vNN-…`.
 * Канарки: A = 127.0.0.2:4196 (HTTP + WS upgrade + UDP/STUN), B = 127.0.0.1:4196 (ловить 0.0.0.0, localhost, CNAME→127.0.0.1).
 * IPv6-loopback у контейнері недоступний (EAFNOSUPPORT) → для [::1]/fc00/fe80/10.x/169.254 доказ — лог проксі (deny)
 * + журнал дайлера (TCP-спроби до цих IP не було), як дозволяє TEST_STRATEGY §6.
 *
 * Прогони (одна й та сама сторінка):
 *   R0 контроль «без захисту»: ті самі launch-опції без прапорців шару 1, контекст без шару 2, SW дозволені → канарка ОТРИМУЄ;
 *   R1 secureLaunch prod (обидва шари), сторінка `attacker.test` → мок-резолвер → 93.184.216.34 → 0 звернень;
 *   R2 лише шар 1 (проксі + прапорці, без context.route/routeWebSocket, SW дозволені) → 0 (проксі сам тримає beacon/ping/WS);
 *   R3 контроль прапорця: проксі є, `<-loopback>` прибрано → loopback-вектори йдуть повз проксі й доходять до канарки;
 *   R4 наївний проксі (перевіряє першу резолв-відповідь, підключається за повторним резолвом) → rebinding-вектори доходять;
 *   R5 fixture-режим (точковий allow-list origin атакувальника, secure context) → SW не реєструється, канарка 0.
 */
import dgram from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyHostname } from "../src/net/ip-classify.js";
import { startEgressProxy, type Dialer, type ProxyDecision, type Resolver, type ResolvedAddress } from "../src/net/egress-proxy.js";
import { applyContextGuards, buildBrowserEnv, buildLaunchOptions, SECURE_CONTEXT_DEFAULTS, secureLaunch, type BlockedRequest } from "../src/secure-launch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ART = path.join(ROOT, "planning/qa/artifacts/sprint-1b/ssrf");
const PORT = 4196; // інші тест-файли тримають 4197–4199
const A = `http://127.0.0.2:${PORT}`;
const FAKE_PUBLIC = "93.184.216.34";

type Run = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "idle";
interface Hit { run: Run; canary: "A" | "B" | "udp"; method: string; path: string }

/** Вектори з канаркою: id → шлях містить id. `ctl` — у якому контролі він мусить дійти до канарки. */
interface Vec { id: string; title: string; ctl: "R0" | "R3" | "R4" | "none"; note?: string }
const VECTORS: Vec[] = [
  { id: "v01", title: "<img> на 127.0.0.2", ctl: "R0" },
  { id: "v02", title: "десятковий IPv4 http://2130706434/", ctl: "R0" },
  { id: "v03", title: "вісімковий 0177.0.0.2", ctl: "R0" },
  { id: "v04", title: "hex 0x7f.0.0.2", ctl: "R0" },
  { id: "v05", title: "скорочений 127.2", ctl: "R0" },
  { id: "v06", title: "IPv4-mapped IPv6 [::ffff:127.0.0.2] (fetch)", ctl: "none", note: "у контейнері немає IPv6-сокетів (EAFNOSUPPORT) → контроль неможливий; доказ — deny у проксі + класифікатор" },
  { id: "v07", title: "0.0.0.0 (→ канарка B)", ctl: "R0" },
  { id: "v08", title: "localhost і LOCALHOST. (→ B)", ctl: "R0" },
  { id: "v09", title: "повноширинні цифри １２７.０.０.２", ctl: "R0" },
  { id: "v10", title: "IDN-гомогліф ⅼocalhost (U+217C) (→ B)", ctl: "R0" },
  { id: "v11", title: "IPv4 з крапкою в кінці 127.0.0.2.", ctl: "R0" },
  { id: "v12", title: "<iframe>", ctl: "R0" },
  { id: "v13", title: "fetch no-cors", ctl: "R0" },
  { id: "v14", title: "XMLHttpRequest", ctl: "R0" },
  { id: "v15", title: "CSS background url()", ctl: "R0" },
  { id: "v16", title: "CSS @font-face src url()", ctl: "R0" },
  { id: "v17", title: "CSS @import", ctl: "R0" },
  { id: "v18", title: "<link rel=prefetch>", ctl: "R0" },
  { id: "v19", title: "<link rel=preload as=image>", ctl: "R0" },
  { id: "v20", title: "<meta http-equiv=refresh> (у iframe)", ctl: "R0" },
  { id: "v21", title: "location= (у iframe)", ctl: "R0" },
  { id: "v22", title: "location= верхнього рівня (окрема сторінка)", ctl: "R0" },
  { id: "v23", title: "window.open popup", ctl: "R0" },
  { id: "v24", title: "navigator.sendBeacon (POST)", ctl: "R0" },
  { id: "v25", title: "WebSocket ws://", ctl: "R0" },
  { id: "v26", title: "Service Worker (install → fetch)", ctl: "R0" },
  { id: "v27", title: "<a ping> (POST при кліку)", ctl: "R0" },
  { id: "v28", title: "302 на 127.0.0.2 (iframe)", ctl: "R0" },
  { id: "v29", title: "301 на 127.0.0.2 (img)", ctl: "R0" },
  { id: "v30", title: "307 на 127.0.0.2 (fetch)", ctl: "R0" },
  { id: "v31", title: "ланцюг 302 → 302 → 127.0.0.2", ctl: "R0" },
  { id: "v32", title: "EventSource", ctl: "R0" },
  { id: "v33", title: "dedicated Worker → fetch", ctl: "R0" },
  { id: "v34", title: "<script src>", ctl: "R0" },
  { id: "v35", title: "<object data>", ctl: "R0" },
  { id: "v36", title: "WebRTC STUN (UDP) на 127.0.0.2", ctl: "R0" },
  { id: "v40", title: "DNS rebinding TTL-0: 1-й резолв публічний, 2-й → 127.0.0.2", ctl: "R4" },
  { id: "v41", title: "змішані A: [публічна, 127.0.0.2]", ctl: "R4" },
  { id: "v42", title: "rebinding між редиректами (той самий хост, 2-й резолв приватний)", ctl: "R4" },
  { id: "v43", title: "ім'я з IP усередині 127.0.0.2.nip.io → 127.0.0.2", ctl: "R0", note: "у R0 спрацював СПРАВЖНІЙ DNS контейнера; статична перевірка імені пропускає — ловить лише перевірка резолву" },
  { id: "v44", title: "CNAME на localhost (резолв → 127.0.0.1)", ctl: "none", note: "статична перевірка імені пропускає" },
  { id: "v45", title: "AAAA-only приватна (::1)", ctl: "none", note: "статична перевірка імені пропускає; IPv6 у контейнері немає" },
];

/** Вектори без слухача (адреси, куди не прив'язатись без root/IPv6): доказ — deny у проксі + дайлер їх не набирав. */
const NO_LISTENER_HOSTS: Array<{ id: string; host: string }> = [
  { id: "v50", host: "169.254.169.254" },
  { id: "v51", host: "metadata.google.internal" },
  { id: "v52", host: "10.0.0.1" },
  { id: "v53", host: "172.16.0.1" },
  { id: "v54", host: "192.168.1.1" },
  { id: "v55", host: "100.64.0.1" },
  { id: "v56", host: "[fc00::1]" },
  { id: "v57", host: "[fe80::1]" },
  { id: "v58", host: "[::1]" },
];

const PROBE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><title>ssrf probe</title>
<style>@import url("${A}/v17-import.css");
@font-face { font-family: probe; src: url("${A}/v16-font.woff"); }
.bg { width: 10px; height: 10px; background: url("${A}/v15-bg.png"); }
.f { font-family: probe; }</style>
<link rel="prefetch" href="${A}/v18-prefetch">
<link rel="preload" as="image" href="${A}/v19-preload.png">
<link rel="dns-prefetch" href="//v37-dnsprefetch.test"><link rel="preconnect" href="http://v38-preconnect.test">
<img src="http://v39-dnsctl.test/x.png">
<h1 id="loaded">probe</h1><div class="bg"></div><p class="f">font</p>
<img src="${A}/v01-img">
<img src="http://2130706434:${PORT}/v02-decimal">
<img src="http://0177.0.0.2:${PORT}/v03-octal">
<img src="http://0x7f.0.0.2:${PORT}/v04-hex">
<img src="http://127.2:${PORT}/v05-short">
<img src="http://0.0.0.0:${PORT}/v07-zero">
<img src="http://localhost:${PORT}/v08-localhost"><img src="http://LOCALHOST.:${PORT}/v08-localhost-dot">
<img src="http://１２７.０.０.２:${PORT}/v09-fullwidth">
<img src="http://ⅼocalhost:${PORT}/v10-idn">
<img src="http://127.0.0.2.:${PORT}/v11-dot">
<iframe src="${A}/v12-iframe"></iframe>
<iframe src="/meta.html"></iframe>
<iframe src="/loc.html"></iframe>
<iframe src="/r302"></iframe>
<img src="/r301">
<iframe src="/chain1"></iframe>
<iframe src="http://rebind2.test:${PORT}/v42-start"></iframe>
<script src="${A}/v34-script.js" async></script>
<object data="${A}/v35-object" type="text/plain" width="1" height="1"></object>
${NO_LISTENER_HOSTS.map((v) => `<img src="http://${v.host}/${v.id}-nolistener">`).join("\n")}
<img src="/redir-10">
<a id="ping" href="/ok" ping="${A}/v27-ping">ping</a>
<script>
const nc = { mode: "no-cors" };
const q = (u) => fetch(u, nc).catch(() => {});
q("http://[::ffff:127.0.0.2]:${PORT}/v06-mapped");
q("${A}/v13-fetch");
try { const x = new XMLHttpRequest(); x.open("GET", "${A}/v14-xhr"); x.send(); } catch (e) {}
try { navigator.sendBeacon("${A}/v24-beacon", "x"); } catch (e) {}
try { new WebSocket("ws://127.0.0.2:${PORT}/v25-ws"); } catch (e) {}
q("/r307");
try { new EventSource("${A}/v32-sse"); } catch (e) {}
try { new Worker("/worker.js"); } catch (e) {}
window.__sw = "n/a";
if (navigator.serviceWorker) navigator.serviceWorker.register("/sw.js").then(() => { window.__sw = "registered"; }, (e) => { window.__sw = "rejected: " + e; });
else window.__sw = "navigator.serviceWorker undefined";
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.2:${PORT}" }] });
  pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o));
} catch (e) {}
// DNS rebinding / резолв-вектори — через ін'єкцію резолвера в проксі (лише в R1/R2/R4)
q("http://rebind.test:${PORT}/v40-a").then(() => q("http://rebind.test:${PORT}/v40-b"));
q("http://mixed.test:${PORT}/v41-mixed");
q("http://127.0.0.2.nip.io:${PORT}/v43-nip");
q("http://cname.test:${PORT}/v44-cname");
q("http://v6only.test:${PORT}/v45-v6only");
addEventListener("load", () => setTimeout(() => { try { window.open("${A}/v23-popup"); } catch (e) {} }, 50));
</script></html>`;

const ATTACKER_ROUTES: Record<string, (res: http.ServerResponse) => void> = {
  "/meta.html": (r) => r.writeHead(200, { "content-type": "text/html" }).end(`<meta http-equiv="refresh" content="0;url=${A}/v20-meta">`),
  "/loc.html": (r) => r.writeHead(200, { "content-type": "text/html" }).end(`<script>location.href = "${A}/v21-location";</script>`),
  "/toploc.html": (r) => r.writeHead(200, { "content-type": "text/html" }).end(`<script>location = "${A}/v22-toploc";</script>`),
  "/r302": (r) => r.writeHead(302, { location: `${A}/v28-r302` }).end(),
  "/r301": (r) => r.writeHead(301, { location: `${A}/v29-r301` }).end(),
  "/r307": (r) => r.writeHead(307, { location: `${A}/v30-r307` }).end(),
  "/chain1": (r) => r.writeHead(302, { location: "/chain2" }).end(),
  "/chain2": (r) => r.writeHead(302, { location: `${A}/v31-chain` }).end(),
  "/v42-start": (r) => r.writeHead(302, { location: `http://rebind2.test:${PORT}/v42-after` }).end(),
  "/redir-10": (r) => r.writeHead(302, { location: "http://10.0.0.1/v52b-redirect" }).end(),
  "/worker.js": (r) => r.writeHead(200, { "content-type": "text/javascript" }).end(`fetch("${A}/v33-worker", { mode: "no-cors" }).catch(() => {});`),
  "/sw.js": (r) =>
    r.writeHead(200, { "content-type": "text/javascript" }).end(`self.addEventListener("install", (e) => e.waitUntil(fetch("${A}/v26-sw", { mode: "no-cors" }).catch(() => {})));`),
};

let run: Run = "idle";
const hits: Hit[] = [];
const attackerHits: Array<{ run: Run; path: string }> = [];
const dialed: Array<{ run: Run; ip: string; port: number }> = [];
let attackerPort = 0;
const servers: http.Server[] = [];
let udp: dgram.Socket;
const tmp: string[] = [];

/** Резолвер «інтернету» з лічильником на ім'я (скидається на кожен прогін). */
let resolveCount = new Map<string, number>();
const resolver: Resolver = async (h): Promise<ResolvedAddress[]> => {
  const n = (resolveCount.get(h) ?? 0) + 1;
  resolveCount.set(h, n);
  const pub: ResolvedAddress = { address: FAKE_PUBLIC, family: 4 };
  if (h === "attacker.test") return [pub];
  if (h === "rebind.test" || h === "rebind2.test") return n === 1 ? [pub] : [{ address: "127.0.0.2", family: 4 }];
  if (h === "mixed.test") return [pub, { address: "127.0.0.2", family: 4 }];
  if (h === "127.0.0.2.nip.io") return [{ address: "127.0.0.2", family: 4 }];
  if (h === "cname.test") return [{ address: "127.0.0.1", family: 4 }]; // CNAME → localhost, lookup повертає кінцеву A
  if (h === "v6only.test") return [{ address: "::1", family: 6 }];
  throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
};
/** «Симульований інтернет»: 93.184.216.34 → локальний сервер атакувальника; БУДЬ-ЯКА інша IP набирається по-справжньому. */
const dial: Dialer = (ip, port) => {
  dialed.push({ run, ip, port });
  return ip === FAKE_PUBLIC ? net.connect(attackerPort, "127.0.0.1") : net.connect({ host: ip, port });
};

function httpCanary(host: string, name: "A" | "B") {
  const s = http.createServer((req, res) => {
    hits.push({ run, canary: name, method: req.method ?? "?", path: req.url ?? "" });
    if ((req.url ?? "").includes("v32-sse")) return void res.writeHead(200, { "content-type": "text/event-stream" }).end("data: x\n\n");
    res.writeHead(200, { "content-type": "text/plain" }).end("canary");
  });
  s.on("upgrade", (req, sock) => {
    hits.push({ run, canary: name, method: "UPGRADE", path: req.url ?? "" });
    sock.destroy();
  });
  servers.push(s);
  return new Promise<void>((r, j) => {
    s.once("error", j);
    s.listen(PORT, host, r);
  });
}

beforeAll(async () => {
  await httpCanary("127.0.0.2", "A");
  await httpCanary("127.0.0.1", "B");
  udp = dgram.createSocket("udp4");
  udp.on("message", (m) => hits.push({ run, canary: "udp", method: "STUN", path: `/v36-stun(${m.length}B)` }));
  await new Promise<void>((r) => udp.bind(PORT, "127.0.0.2", r));
  const att = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    attackerHits.push({ run, path: p });
    if (p === "/probe.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PROBE_HTML);
    const route = ATTACKER_ROUTES[p];
    if (route) return void route(res);
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  servers.push(att);
  await new Promise<void>((r) => att.listen(0, "127.0.0.1", r));
  attackerPort = (att.address() as AddressInfo).port;
  mkdirSync(ART, { recursive: true });
});
afterAll(async () => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  udp?.close();
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function envDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), "sl-vec-"));
  tmp.push(d);
  for (const sub of ["home/.config", "home/.cache", "tmp"]) mkdirSync(path.join(d, sub), { recursive: true });
  return d;
}

/** Відкрити probe, дочекатись, клікнути <a ping>, відкрити сторінку з top-level location=. */
async function drive(ctx: BrowserContext, origin: string) {
  const page = await ctx.newPage();
  await page.goto(`${origin}/probe.html`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(2500);
  const loaded = (await page.locator("#loaded").count().catch(() => 0)) > 0;
  const sw = await page.evaluate(() => (window as unknown as { __sw: string }).__sw).catch((e) => `eval failed: ${String(e).slice(0, 80)}`);
  await page.click("#ping", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);
  const p2 = await ctx.newPage();
  await p2.goto(`${origin}/toploc.html`, { waitUntil: "load" }).catch(() => {});
  await p2.waitForTimeout(1200);
  return { loaded, sw };
}

function begin(r: Run) {
  run = r;
  resolveCount = new Map();
}
const hitsOf = (r: Run) => hits.filter((h) => h.run === r);
const brief = (log: ProxyDecision[]) =>
  log.filter((l) => l.host !== "attacker.test").map((l) => ({ via: l.via, method: l.method, host: l.host, port: l.port, path: l.path, decision: l.decision, reason: l.reason.slice(0, 90), connected_ip: l.connected_ip }));
function save(name: string, data: unknown) {
  writeFileSync(path.join(ART, name), JSON.stringify(data, null, 1) + "\n");
}

const proxyLogs: Partial<Record<Run, ProxyDecision[]>> = {};
const layer2: Partial<Record<Run, BlockedRequest[]>> = {};
const swState: Partial<Record<Run, string>> = {};

/** Мінімальний «наївний» HTTP-проксі (контроль R4): перевіряє ПЕРШУ адресу першого резолву, підключається за НОВИМ резолвом (остання адреса). */
async function naiveProxy() {
  const log: Array<{ host: string; path: string; decision: string; ip?: string }> = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url ?? "");
    const port = Number(u.port || 80);
    void (async () => {
      const lit = net.isIP(u.hostname.replace(/^\[|\]$/g, ""));
      try {
        if (lit || !classifyHostname(u.hostname).allowed) throw new Error("literal/name deny");
        const first = await resolver(u.hostname);
        if (first[0]!.address !== FAKE_PUBLIC) throw new Error("first address private");
        const again = await resolver(u.hostname); // «перевір, потім підключись за ім'ям»
        const ip = again.at(-1)!.address;
        log.push({ host: u.hostname, path: u.pathname, decision: "allow", ip });
        const up = http.request({ method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host }, createConnection: () => dial(ip, port) }, (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        });
        up.on("error", () => res.writeHead(502).end());
        req.pipe(up);
      } catch (e) {
        log.push({ host: u.hostname, path: u.pathname, decision: `deny: ${(e as Error).message}` });
        res.writeHead(403).end();
      }
    })();
  });
  s.on("connect", (_req, sock) => sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, log, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

describe("SSRF-вектори наскрізно (S1b, ≥ 25, кожен із контролем)", () => {
  it("R0 контроль без захисту: сторінка з 127.0.0.1 → канарка отримує браузерні вектори", async () => {
    begin("R0");
    const d = await envDir();
    const base = buildLaunchOptions("unused", buildBrowserEnv(d));
    const netlog = path.join(d, "netlog-r0.json");
    const browser = await chromium.launch({ ...base, args: [`--log-net-log=${netlog}`, "--net-log-capture-mode=Everything"] });
    try {
      const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: "allow" });
      const r = await drive(ctx, `http://127.0.0.1:${attackerPort}`);
      swState.R0 = r.sw;
      expect(r.loaded).toBe(true);
      await ctx.close();
    } finally {
      await browser.close();
    }
    netlogSummary.R0 = dnsJobs(netlog);
    save("r0-control-unprotected.json", { run: "R0", scenario: "без прапорців шару 1, без шару 2, SW allow; сторінка http://127.0.0.1:<port>", sw: swState.R0, canary_hits: hitsOf("R0"), dns_jobs: netlogSummary.R0 });
    expect(hitsOf("R0").length).toBeGreaterThan(20);
  }, 60_000);

  it("R1 secureLaunch prod (обидва шари): 0 звернень до канарки, кожен вектор залоговано", async () => {
    begin("R1");
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    let loaded = false;
    try {
      const ctx = await sb.newContext();
      const r = await drive(ctx, "http://attacker.test");
      loaded = r.loaded;
      swState.R1 = r.sw;
      await ctx.close();
    } finally {
      await sb.close();
    }
    proxyLogs.R1 = sb.proxy.log;
    layer2.R1 = sb.blocked;
    save("r1-secure-prod.json", { run: "R1", scenario: "secureLaunch prod; attacker.test → 93.184.216.34", page_loaded: loaded, sw: swState.R1, canary_hits: hitsOf("R1"), dialed_non_attacker: dialed.filter((x) => x.run === "R1" && x.ip !== FAKE_PUBLIC), proxy_decisions: brief(sb.proxy.log), layer2_blocked: sb.blocked.map((b) => ({ kind: b.kind, method: b.method, url: b.url })) });
    expect(loaded).toBe(true);
    expect(hitsOf("R1")).toEqual([]);
  }, 60_000);

  it("R2 лише шар 1 (без context.route/routeWebSocket, SW allow): 0 звернень — проксі сам тримає beacon/ping/WS", async () => {
    begin("R2");
    const d = await envDir();
    const proxy = await startEgressProxy({ mode: { kind: "prod" }, resolver, dial });
    const netlog = path.join(d, "netlog-r2.json");
    const base = buildLaunchOptions(proxy.url, buildBrowserEnv(d));
    const browser = await chromium.launch({ ...base, args: [...base.args!, `--log-net-log=${netlog}`, "--net-log-capture-mode=Everything"] });
    let loaded = false;
    try {
      const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: "allow" });
      const r = await drive(ctx, "http://attacker.test");
      loaded = r.loaded;
      swState.R2 = r.sw;
      await ctx.close();
    } finally {
      await browser.close();
      await proxy.close();
    }
    proxyLogs.R2 = proxy.log;
    netlogSummary.R2 = dnsJobs(netlog);
    save("r2-layer1-only.json", { run: "R2", scenario: "egress-проксі prod + прапорці; без шару 2", page_loaded: loaded, sw: swState.R2, canary_hits: hitsOf("R2"), dialed_non_attacker: dialed.filter((x) => x.run === "R2" && x.ip !== FAKE_PUBLIC), proxy_decisions: brief(proxy.log), dns_jobs: netlogSummary.R2 });
    expect(loaded).toBe(true);
    expect(hitsOf("R2")).toEqual([]);
  }, 60_000);

  it("R3 контроль прапорця: проксі без <-loopback> → loopback-вектори обходять проксі й доходять до канарки", async () => {
    begin("R3");
    const d = await envDir();
    const proxy = await startEgressProxy({ mode: { kind: "prod" }, resolver, dial });
    const base = buildLaunchOptions(proxy.url, buildBrowserEnv(d));
    const browser = await chromium.launch({ ...base, args: base.args!.filter((a) => !a.startsWith("--proxy-bypass-list")) });
    const blocked: BlockedRequest[] = [];
    try {
      const ctx = await browser.newContext(SECURE_CONTEXT_DEFAULTS);
      await applyContextGuards(ctx, blocked);
      await drive(ctx, "http://attacker.test");
      await ctx.close();
    } finally {
      await browser.close();
      await proxy.close();
    }
    save("r3-control-no-loopback-flag.json", { run: "R3", scenario: "проксі є, --proxy-bypass-list=<-loopback> прибрано", canary_hits: hitsOf("R3"), proxy_decisions: brief(proxy.log) });
    expect(hitsOf("R3").length).toBeGreaterThan(0);
  }, 60_000);

  it("R4 контроль резолв-векторів: наївний проксі («перевір 1-й резолв, підключись за новим») → rebinding доходить до канарки", async () => {
    begin("R4");
    const d = await envDir();
    const np = await naiveProxy();
    const base = buildLaunchOptions(np.url, buildBrowserEnv(d));
    const browser = await chromium.launch(base);
    const blocked: BlockedRequest[] = [];
    try {
      const ctx = await browser.newContext(SECURE_CONTEXT_DEFAULTS);
      await applyContextGuards(ctx, blocked);
      await drive(ctx, "http://attacker.test");
      await ctx.close();
    } finally {
      await browser.close();
      await np.close();
    }
    save("r4-control-naive-proxy.json", { run: "R4", scenario: "наївний проксі (TOCTOU-резолв), ті самі прапорці й шар 2", canary_hits: hitsOf("R4"), naive_log: np.log.filter((l) => l.host !== "attacker.test") });
    expect(hitsOf("R4").length).toBeGreaterThan(0);
  }, 60_000);

  it("R5 fixture (точковий allow-list origin атакувальника, secure context): SW заблоковано (SecurityError), скрипт SW не запитано, канарка 0", async () => {
    begin("R5");
    const origin = `http://127.0.0.1:${attackerPort}`;
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
    let loaded = false;
    try {
      const ctx = await sb.newContext();
      const r = await drive(ctx, origin);
      loaded = r.loaded;
      swState.R5 = r.sw;
      await ctx.close();
    } finally {
      await sb.close();
    }
    const swFetched = attackerHits.some((h) => h.run === "R5" && h.path === "/sw.js");
    save("r5-fixture-allowlist.json", { run: "R5", scenario: `fixture, allow-list лише ${origin}`, page_loaded: loaded, sw: swState.R5, sw_script_fetched: swFetched, canary_hits: hitsOf("R5"), proxy_decisions: brief(sb.proxy.log).filter((l) => l.port !== attackerPort) });
    expect(loaded).toBe(true);
    expect(hitsOf("R5")).toEqual([]);
    expect(swState.R5).toMatch(/rejected: SecurityError/);
    expect(swFetched).toBe(false);
    // контроль allow-list: іншого loopback-порту/хоста немає в дозволених
    expect(sb.proxy.log.filter((l) => l.decision === "allow").every((l) => l.port === attackerPort)).toBe(true);
    expect(swState.R0).toBe("registered");
  }, 60_000);

  it("матриця векторів: кожен — 0 у R1 і R2, deny у лозі, контроль дійшов до канарки", () => {
    const pathHas = (id: string) => (h: { path?: string }) => (h.path ?? "").includes(`/${id}-`) || (h.path ?? "").startsWith(`/${id}-`);
    const rows = VECTORS.map((v) => {
      const r0 = hitsOf("R0").filter(pathHas(v.id)).length;
      const r3 = hitsOf("R3").filter(pathHas(v.id)).length;
      const r4 = hitsOf("R4").filter(pathHas(v.id)).length;
      const r1 = hitsOf("R1").filter(pathHas(v.id)).length;
      const r2 = hitsOf("R2").filter(pathHas(v.id)).length;
      const l1 = (proxyLogs.R1 ?? []).filter((l) => l.decision !== "allow" && (l.path ?? "").includes(`/${v.id}-`)).length;
      const l2 = (proxyLogs.R2 ?? []).filter((l) => l.decision !== "allow" && (l.path ?? "").includes(`/${v.id}-`)).length;
      const b1 = (layer2.R1 ?? []).filter((b) => b.url.includes(`/${v.id}-`)).length;
      return { id: v.id, title: v.title, control_run: v.ctl, control_hits: v.ctl === "none" ? null : { R0: r0, R3: r3, R4: r4 }[v.ctl], R1_hits: r1, R2_hits: r2, R1_proxy_deny: l1, R1_layer2_block: b1, R2_proxy_deny: l2, note: v.note ?? null };
    });
    // Спеціальні контролі/докази
    const connectDeny = (log: ProxyDecision[] | undefined, host: string, port: number) => (log ?? []).filter((l) => l.via === "connect" && l.decision === "deny" && l.host.replace(/^\[|\]$/g, "") === host && l.port === port).length;
    const extra = {
      v25_ws_R2_connect_deny: connectDeny(proxyLogs.R2, "127.0.0.2", PORT),
      v36_stun_note: "WebRTC: UDP не йде через HTTP-проксі; disable_non_proxied_udp забороняє UDP взагалі",
      no_listener: NO_LISTENER_HOSTS.map((n) => {
        const h = n.host.replace(/^\[|\]$/g, "");
        const d1 = (proxyLogs.R1 ?? []).filter((l) => l.decision === "deny" && l.host.replace(/^\[|\]$/g, "") === h).length;
        const d2 = (proxyLogs.R2 ?? []).filter((l) => l.decision === "deny" && l.host.replace(/^\[|\]$/g, "") === h).length;
        const dialedR = dialed.filter((x) => (x.run === "R1" || x.run === "R2") && x.ip === h).length;
        return { id: n.id, host: n.host, R1_proxy_deny: d1, R2_proxy_deny: d2, tcp_dials_R1_R2: dialedR };
      }),
      static_name_check_passes: Object.fromEntries(["127.0.0.2.nip.io", "cname.test", "v6only.test", "rebind.test", "mixed.test"].map((h) => [h, classifyHostname(h).allowed])),
      redirect_to_10_R1_deny: (proxyLogs.R1 ?? []).filter((l) => l.decision === "deny" && (l.path ?? "").includes("/v52b-")).length,
      dialer_positive_control: dialed.filter((x) => x.run === "R1" && x.ip === FAKE_PUBLIC).length,
      sw: swState,
    };
    save("vectors-matrix.json", { schema: "sitelens-ssrf-vectors/v1", canary: { A: `127.0.0.2:${PORT}`, B: `127.0.0.1:${PORT}`, udp: `127.0.0.2:${PORT}` }, rows, extra });
    for (const r of rows) {
      expect(r.R1_hits, `${r.id} R1`).toBe(0);
      expect(r.R2_hits, `${r.id} R2`).toBe(0);
      if (r.control_run !== "none") expect(r.control_hits, `${r.id} контроль ${r.control_run} мусить дійти до канарки`).toBeGreaterThan(0);
    }
    for (const n of extra.no_listener) {
      expect(n.R1_proxy_deny + n.R2_proxy_deny, `${n.host} deny`).toBeGreaterThan(0);
      expect(n.tcp_dials_R1_R2, `${n.host} TCP`).toBe(0);
    }
    expect(extra.dialer_positive_control).toBeGreaterThan(0);
    // контроль для резолв-векторів без слухача: статична перевірка імені їх ПРОПУСКАЄ — ловить лише перевірка резолву
    for (const [h, ok] of Object.entries(extra.static_name_check_passes)) expect(ok, h).toBe(true);
  });
});

describe("P-3: рівень проксі — екзотичні цілі CONNECT/HTTP напряму (без браузера)", () => {
  it("zone-id, 0, скорочені/hex/mapped/крапка, порожні й некоректні цілі → 400/403, 0 TCP до не-публічних; контроль — публічне ім'я → 200", async () => {
    begin("idle");
    const proxy = await startEgressProxy({ mode: { kind: "prod" }, resolver, dial, clientAuth: "token" });
    const raw = (line: string) =>
      new Promise<number>((resolve) => {
        const sock = net.connect(proxy.port, "127.0.0.1", () => sock.write(`${line}\r\nProxy-Authorization: ${proxy.authHeader}\r\nHost: x\r\n\r\n`));
        let buf = "";
        sock.on("data", (c) => {
          buf += c.toString("latin1");
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m) {
            sock.destroy();
            resolve(Number(m[1]));
          }
        });
        sock.on("error", () => resolve(-1));
        sock.on("close", () => resolve(/^HTTP\/1\.1 (\d{3})/.exec(buf) ? Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)![1]) : -1));
      });
    const targets = [
      `CONNECT [fe80::1%lo]:${PORT} HTTP/1.1`, `CONNECT [fe80::1%25lo]:${PORT} HTTP/1.1`, `CONNECT 0:${PORT} HTTP/1.1`, `CONNECT 0x7f000002:${PORT} HTTP/1.1`,
      `CONNECT 127.0.0.2.:${PORT} HTTP/1.1`, `CONNECT [::ffff:7f00:2]:${PORT} HTTP/1.1`, `CONNECT [::]:${PORT} HTTP/1.1`, `CONNECT 127.0.0.2:0 HTTP/1.1`,
      `CONNECT 127.0.0.2:70000 HTTP/1.1`, `CONNECT :${PORT} HTTP/1.1`, `CONNECT 127.0.0.2 HTTP/1.1`,
      `GET http://0177.0.0.02:${PORT}/p3 HTTP/1.1`, `GET http://[::ffff:127.0.0.2]:${PORT}/p3 HTTP/1.1`, `GET /relative HTTP/1.1`, `GET gopher://127.0.0.2:${PORT}/ HTTP/1.1`,
    ];
    const out: Array<{ target: string; status: number }> = [];
    try {
      for (const t of targets) out.push({ target: t, status: await raw(t) });
      const control = await raw("CONNECT attacker.test:443 HTTP/1.1");
      const privDials = dialed.filter((d) => d.run === "idle" && d.ip !== FAKE_PUBLIC);
      save("p3-proxy-exotic-targets.json", { results: out, control_public_connect: control, private_tcp_dials: privDials, canary_hits: hitsOf("idle"), proxy_decisions: brief(proxy.log) });
      for (const r of out) expect([400, 403], r.target).toContain(r.status);
      expect(control).toBe(200);
      expect(privDials).toEqual([]);
      expect(hitsOf("idle")).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});

// ---- SW-1: обхід Playwright serviceWorkers:'block' (знахідка S1b) ----
const SW_VARIANTS = ["instance", "proto", "iframe"] as const;
const swPage = (v: string) => `<!doctype html><title>${v}</title><body><script>
window.__r = "pending";
addEventListener("load", () => { try { let p;
  if ("${v}" === "instance") p = navigator.serviceWorker.register("/swx-${v}.js");
  if ("${v}" === "proto") p = ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/swx-${v}.js");
  if ("${v}" === "iframe") { const f = document.createElement("iframe"); document.body.appendChild(f); p = f.contentWindow.ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/swx-${v}.js"); }
  Promise.resolve(p).then((r) => window.__r = "ok:" + (r ? r.constructor.name : String(r)), (e) => window.__r = "rejected: " + e);
} catch (e) { window.__r = "throw: " + e; } });
</script>`;
const SW_SCRIPT = (v: string) => `self.addEventListener("install", (e) => e.waitUntil(Promise.all([
  fetch("/swx-post/${v}", { method: "POST", body: "state-change" }).catch(() => {}),
  fetch("${A}/v26-swx-${v}", { mode: "no-cors" }).catch(() => {}) ])));`;

describe("SW-1: реєстрація Service Worker в обхід блоку і не-GET із SW (S1b)", () => {
  let srv: http.Server;
  let origin = "";
  const req: Array<{ run: string; method: string; path: string }> = [];
  let swRun = "";
  beforeAll(async () => {
    srv = http.createServer((q, r) => {
      const p = q.url ?? "";
      req.push({ run: swRun, method: q.method ?? "?", path: p });
      const m = /^\/sw-(\w+)\.html/.exec(p);
      if (m) return void r.writeHead(200, { "content-type": "text/html" }).end(swPage(m[1]!));
      const j = /^\/swx-(\w+)\.js/.exec(p);
      if (j) return void r.writeHead(200, { "content-type": "text/javascript" }).end(SW_SCRIPT(j[1]!));
      r.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  async function drive3(ctxFactory: () => Promise<BrowserContext>) {
    const out: Record<string, string> = {};
    for (const v of SW_VARIANTS) {
      const ctx = await ctxFactory();
      const p = await ctx.newPage();
      await p.goto(`${origin}/sw-${v}.html`).catch(() => {});
      await p.waitForTimeout(1500);
      out[v] = await p.evaluate(() => (window as unknown as { __r: string }).__r).catch((e) => String(e).slice(0, 60));
      await ctx.close();
    }
    return out;
  }

  it("контроль: Playwright serviceWorkers:'block' (стара конфігурація S1a) → prototype/iframe-обхід реєструє SW, POST із SW доходить до цілі", async () => {
    swRun = "old";
    begin("idle");
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
    const blocked: BlockedRequest[] = [];
    let res: Record<string, string>;
    try {
      res = await drive3(async () => {
        const c = await sb.browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [] });
        await applyContextGuards(c, blocked, { swLockdown: false }); // шар 2 як у S1a (route/WS), без нового блоку SW
        return c;
      });
    } finally {
      await sb.close();
    }
    const posts = req.filter((r) => r.run === "old" && r.method === "POST");
    save("sw1-control-playwright-block.json", { scenario: "S1a: serviceWorkers:'block' + context.route", registration: res, target_received: req.filter((r) => r.run === "old" && !r.path.endsWith(".html")), layer2_blocked: blocked.map((b) => `${b.kind} ${b.method} ${b.url}`) });
    expect(res.instance).toBe("ok:undefined"); // екземпляр підмінено Playwright — «успіх» без реєстрації
    expect(res.proto).toBe("ok:ServiceWorkerRegistration");
    expect(posts.map((p) => p.path)).toEqual(expect.arrayContaining(["/swx-post/proto"])); // не-GET дійшов до цілі
  }, 60_000);

  it("SecureBrowser: усі 3 варіанти → SecurityError, ціль не отримала жодного запиту SW; шар 2 без lockdown теж рубає скрипт SW", async () => {
    swRun = "new";
    begin("idle");
    const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
    let res: Record<string, string>;
    let resL2: Record<string, string>;
    const l2: BlockedRequest[] = [];
    try {
      res = await drive3(() => sb.newContext());
      swRun = "l2";
      resL2 = await drive3(async () => {
        const c = await sb.browser.newContext(SECURE_CONTEXT_DEFAULTS);
        await applyContextGuards(c, l2, { swLockdown: false });
        return c;
      });
    } finally {
      await sb.close();
    }
    const swReq = (run: string) => req.filter((r) => r.run === run && !r.path.endsWith(".html"));
    save("sw1-secure.json", { secure: { registration: res, target_received: swReq("new"), layer2_blocked: sb.blocked.map((b) => `${b.kind} ${b.method} ${b.url}`) }, layer2_without_lockdown: { registration: resL2, target_received: swReq("l2"), layer2_blocked: l2.map((b) => `${b.kind} ${b.method} ${b.url}`) }, canary_hits: hitsOf("idle") });
    for (const v of SW_VARIANTS) expect(res[v], v).toMatch(/rejected: SecurityError/);
    expect(swReq("new")).toEqual([]);
    expect(swReq("l2")).toEqual([]);
    expect(l2.filter((b) => b.kind === "service_worker" && b.method === "GET").length).toBe(3);
    expect(hitsOf("idle")).toEqual([]);
  }, 60_000);
});

describe("dns-prefetch / preconnect — відомий DNS-витік (V37/V38)", () => {
  it("netlog: у R2 (проксі) Chromium не робить жодного DNS-запиту; контроль R0 — img на ім'я дає DNS-запит (детектор уміє впасти)", () => {
    const r0 = netlogSummary.R0 ?? {};
    const r2 = netlogSummary.R2 ?? {};
    const has = (m: Record<string, number>, n: string) => Object.keys(m).some((k) => k.includes(n));
    const res = {
      control_R0_img_name_dns_job: has(r0, "v39-dnsctl.test"),
      R0_dns_prefetch_job: has(r0, "v37-dnsprefetch.test"),
      R0_preconnect_job: has(r0, "v38-preconnect.test"),
      R2_any_dns_jobs: Object.keys(r2).filter((k) => !k.includes("127.0.0.1")),
      R2_dns_prefetch_job: has(r2, "v37-dnsprefetch.test"),
      R2_preconnect_job: has(r2, "v38-preconnect.test"),
    };
    save("dns-prefetch-netlog.json", { schema: "sitelens-dns-leak/v1", method: "Chromium --log-net-log, події HOST_RESOLVER_MANAGER_JOB", ...res, r0_jobs: r0, r2_jobs: r2 });
    expect(res.control_R0_img_name_dns_job).toBe(true);
    expect(res.R2_dns_prefetch_job).toBe(false);
    expect(res.R2_preconnect_job).toBe(false);
    expect(res.R2_any_dns_jobs).toEqual([]);
  });
});

// ---- dns-prefetch / DNS-витік: netlog HOST_RESOLVER_MANAGER_JOB (реальний DNS-запит браузера) ----
const netlogSummary: Partial<Record<Run, Record<string, number>>> = {};
function dnsJobs(file: string): Record<string, number> {
  if (!existsSync(file)) return { __missing: 1 };
  let t = readFileSync(file, "utf8").trim().replace(/,\s*$/, "");
  let j: { constants: { logEventTypes: Record<string, number> }; events: Array<{ type: number; params?: unknown }> };
  try {
    j = JSON.parse(t);
  } catch {
    t += "]}";
    j = JSON.parse(t);
  }
  const jobType = j.constants.logEventTypes.HOST_RESOLVER_MANAGER_JOB;
  const out: Record<string, number> = {};
  for (const e of j.events) {
    if (e.type !== jobType) continue;
    const host = /"host":"([^"]+)"/.exec(JSON.stringify(e.params ?? {}))?.[1];
    if (host) out[host] = (out[host] ?? 0) + 1;
  }
  return out;
}
