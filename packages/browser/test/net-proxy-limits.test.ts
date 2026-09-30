/**
 * S1b: автентифікація клієнтів проксі, ліміти, happy eyeballs, SITE_DENYLIST.
 * Кожна перевірка має контроль: той самий вхід без захисту (або з вимкненим лімітом) — проходить.
 * Без DNS і без зовнішньої мережі: резолвер і дайлер ін'єктовані («симульований інтернет»).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type Dialer, type EgressProxy, type ProxyDecision, type Resolver } from "../src/net/egress-proxy.js";
import { peerCheckAvailable } from "../src/net/peer-check.js";
import { assertSiteAllowed, isSiteDenied, matchSiteDenylist, parseSiteDenylist, SITE_DENYLIST_ENV, loadSiteDenylist } from "../src/net/site-denylist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ART = path.join(ROOT, "planning/qa/artifacts/sprint-1b/proxy");
const PUB4 = "93.184.216.34";
const PUB6 = "2606:4700:4700::1111";
/** Класифікатор повертає IPv6 у розгорнутій формі — дайлер отримує саме її. */
const PUB6_CANON = "2606:4700:4700:0:0:0:0:1111";

let echo: net.Server;
let echoPort: number;
let big: http.Server;
let bigPort: number;
let trickle: net.Server;
let trickleHits = 0;
let trickleActive = 0;
let trickleMaxActive = 0;
const tmp: string[] = [];
const artifact: Record<string, unknown> = {};

beforeAll(async () => {
  echo = net.createServer((s) => {
    s.on("error", () => {});
    s.pipe(s);
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;
  // /big?n=BYTES[&cl=0] — n байт; cl=0 → chunked без content-length
  big = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const n = Number(u.searchParams.get("n") ?? 0);
    if (u.pathname === "/silent") return; // ніколи не відповідає
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/octet-stream" };
    if (u.searchParams.get("cl") !== "0") headers["content-length"] = String(n);
    res.writeHead(200, headers);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < n) {
        const part = chunk.subarray(0, Math.min(chunk.length, n - sent));
        sent += part.length;
        if (!res.write(part)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });
  big.on("clientError", () => {});
  await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
  bigPort = (big.address() as AddressInfo).port;
  // TCP-сервер, що шле 1 байт кожні 50 мс без кінця (для maxConnectionMs) і рахує активні з'єднання
  trickle = net.createServer((s) => {
    trickleHits++;
    trickleActive++;
    trickleMaxActive = Math.max(trickleMaxActive, trickleActive);
    const t = setInterval(() => s.write("x"), 50);
    s.on("error", () => {});
    s.on("close", () => {
      trickleActive--;
      clearInterval(t);
    });
  });
  await new Promise<void>((r) => trickle.listen(0, "127.0.0.1", r));
  mkdirSync(ART, { recursive: true });
});
afterAll(async () => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  writeFileSync(path.join(ART, "proxy-limits-auth.json"), JSON.stringify(artifact, null, 2) + "\n");
  await new Promise((r) => echo.close(r));
  big.closeAllConnections();
  await new Promise((r) => big.close(r));
  await new Promise((r) => trickle.close(r));
});

const resolverOf = (table: Record<string, string[]>) => {
  const calls: string[] = [];
  const resolver: Resolver = async (h) => {
    calls.push(h);
    const e = table[h];
    if (!e) throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
    return e.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
  };
  return { calls, resolver };
};
/** Дайлер «інтернету»: публічна IP → локальний порт; `dead` — ECONNREFUSED; `hang` — сокет, що ніколи не з'єднається. */
function netDialer(map: Record<string, number | "dead" | "hang">) {
  const calls: string[] = [];
  const dial: Dialer = (ip) => {
    calls.push(ip);
    const t = map[ip];
    if (t === "hang") return new net.Socket();
    if (t === undefined || t === "dead") return net.connect({ host: "127.0.0.1", port: 1 });
    return net.connect({ host: "127.0.0.1", port: t });
  };
  return { calls, dial };
}

function rawConnect(proxy: EgressProxy, target: string, auth: string | null, onTunnel?: (s: net.Socket) => void): Promise<{ status: number; bytes: number; closedMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(proxy.port, "127.0.0.1");
    let head = "";
    let status = 0;
    let bytes = 0;
    s.on("data", (d) => {
      if (!status) {
        head += d.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
        bytes += Buffer.byteLength(head.slice(end + 4), "latin1");
        if (status === 200) onTunnel?.(s);
        return;
      }
      bytes += d.length;
    });
    s.on("error", () => {});
    s.on("close", () => resolve({ status, bytes, closedMs: Date.now() - t0 }));
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
  });
}

function httpGet(proxy: EgressProxy, url: string, auth: string | null = proxy.authHeader): Promise<{ status: number; bytes: number; aborted: boolean }> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: url, headers: { host: new URL(url).host, ...(auth ? { "proxy-authorization": auth } : {}) } }, (res) => {
      let bytes = 0;
      let aborted = false;
      res.on("data", (d: Buffer) => (bytes += d.length));
      res.on("aborted", () => (aborted = true));
      res.on("error", () => (aborted = true));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, bytes, aborted: aborted || !res.complete }));
    });
    req.on("error", () => resolve({ status: 0, bytes: 0, aborted: true }));
    req.end();
  });
}

const brief = (l: ProxyDecision[]) => l.map((x) => ({ via: x.via, host: x.host, port: x.port, decision: x.decision, reason: x.reason, connected_ip: x.connected_ip, bytes_down: x.bytes_down, dial_failures: x.dial_failures, peer_pid: x.peer_pid }));

/** Клієнт в ОКРЕМОМУ процесі. `orphan: true` — подвійний fork: процес не є нащадком worker (як сторонній локальний процес). */
async function foreignConnect(proxyPort: number, target: string, orphan: boolean, auth: string | null = null): Promise<{ status: number; pid: number }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sl-foreign-"));
  tmp.push(dir);
  const out = path.join(dir, "out.json");
  const code = `const net=require("net");const fs=require("fs");const s=net.connect(${proxyPort},"127.0.0.1");let b="";
s.on("data",d=>{b+=d;const m=/^HTTP\\/1\\.1 (\\d+)/.exec(b);if(m){fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({status:+m[1],pid:process.pid}));s.destroy();}});
s.on("error",e=>{fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({status:-1,pid:process.pid,err:String(e)}));});
s.write("CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n${auth ? `Proxy-Authorization: ${auth}\\r\\n` : ""}\\r\\n");`;
  const script = path.join(dir, "client.cjs");
  writeFileSync(script, code);
  if (orphan) {
    // sh запускає node у фоні й одразу виходить → node переходить до init/subreaper, не нащадок worker
    const sh = spawn("/bin/sh", ["-c", `(sleep 0.3; exec "${process.execPath}" "${script}") >/dev/null 2>&1 &`], { stdio: "ignore" });
    await new Promise((r) => sh.on("exit", r));
  } else {
    spawn(process.execPath, [script], { stdio: "ignore" });
  }
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(out)) throw new Error("сторонній клієнт не відповів");
  return JSON.parse(readFileSync(out, "utf8")) as { status: number; pid: number };
}

describe("автентифікація клієнтів проксі (peer-check нащадків worker + токен)", () => {
  it.skipIf(!peerCheckAvailable())("сторонній процес без токена → 407; нащадок worker → 200; контроль clientAuth=open → сторонній проходить", async () => {
    const r = resolverOf({ "public.test": [PUB4] });
    const d = netDialer({ [PUB4]: echoPort });
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    const open = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, clientAuth: "open" });
    try {
      expect(p.authMode).toBe("peer-or-token");
      const orphan = await foreignConnect(p.port, "public.test:443", true);
      const orphanTok = await foreignConnect(p.port, "public.test:443", true, p.authHeader);
      const child = await foreignConnect(p.port, "public.test:443", false);
      const inproc = await rawConnect(p, "public.test:443", null);
      const inprocTok = await rawConnect(p, "public.test:443", p.authHeader, (s) => s.destroy());
      const wrongTok = await rawConnect(p, "public.test:443", "Bearer nope", (s) => s.destroy());
      const ctlOrphan = await foreignConnect(open.port, "public.test:443", true);
      artifact.auth = {
        orphan_no_token: orphan,
        orphan_with_token: orphanTok,
        child_no_token: child,
        in_process_no_token: inproc.status,
        in_process_token: inprocTok.status,
        wrong_token: wrongTok.status,
        control_open_orphan: ctlOrphan,
        proxy_log: brief(p.log),
      };
      expect(orphan.status).toBe(407);
      expect(orphanTok.status).toBe(200);
      expect(child.status).toBe(200);
      expect(inproc.status).toBe(407); // сам worker не нащадок себе — лише з токеном
      expect(inprocTok.status).toBe(200);
      expect(wrongTok.status).toBe(407);
      expect(ctlOrphan.status).toBe(200); // контроль: без автентифікації сторонній процес користується проксі
      const unauth = p.log.filter((l) => l.decision === "unauthorized");
      expect(unauth).toHaveLength(3);
      const childAllow = p.log.find((l) => l.decision === "allow" && l.peer_pid === child.pid);
      expect(childAllow, "allow з peer_pid дочірнього процесу").toBeTruthy();
      // жодного TCP для відхилених клієнтів: дайлер викликано лише для 3 дозволених (orphanTok, child, inprocTok)
      expect(d.calls.length).toBe(3 + 1); // + контроль open
    } finally {
      await p.close();
      await open.close();
    }
  });

  it("clientAuth=token: без токена навіть нащадок → 407", async () => {
    const r = resolverOf({ "public.test": [PUB4] });
    const d = netDialer({ [PUB4]: echoPort });
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, clientAuth: "token", authToken: "t0k3n" });
    try {
      expect((await httpGet(p, "http://public.test/", null)).status).toBe(407);
      expect((await httpGet(p, "http://public.test/", "Basic " + Buffer.from("sitelens:t0k3n").toString("base64"))).status).not.toBe(407);
      expect(d.calls).toHaveLength(1);
    } finally {
      await p.close();
    }
  });
});

describe("ліміти проксі", () => {
  it("maxResponseBytes: HTTP з content-length і chunked, CONNECT-тунель — обрізано й залоговано; контроль: великий ліміт → повна відповідь", async () => {
    const r = resolverOf({ "big.test": [PUB4] });
    const d = netDialer({ [PUB4]: bigPort });
    const LIM = 1024 * 1024;
    const N = 3 * LIM;
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { maxResponseBytes: LIM } });
    const ctl = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { maxResponseBytes: 10 * N } });
    try {
      const withCl = await httpGet(p, `http://big.test/big?n=${N}`);
      const chunked = await httpGet(p, `http://big.test/big?n=${N}&cl=0`);
      const ctlRes = await httpGet(ctl, `http://big.test/big?n=${N}&cl=0`);
      artifact.max_response_bytes = { limit: LIM, body: N, with_content_length: withCl, chunked, control: ctlRes, log: brief(p.log) };
      expect(withCl.status).toBe(502); // відмова за заголовком, тіло не пересилається
      expect(withCl.bytes).toBe(0);
      expect(chunked.bytes).toBeLessThanOrEqual(LIM + 128 * 1024);
      expect(chunked.aborted).toBe(true);
      expect(ctlRes).toEqual({ status: 200, bytes: N, aborted: false });
      expect(p.log.filter((l) => l.decision === "limit" && l.reason.startsWith("maxResponseBytes"))).toHaveLength(2);
    } finally {
      await p.close();
      await ctl.close();
    }
  });

  it("CONNECT-тунель: maxResponseBytes і maxConnectionMs обривають потік; контроль — без ліміту тунель живий", async () => {
    const tport = (trickle.address() as AddressInfo).port;
    const r = resolverOf({ "trickle.test": [PUB4] });
    const d = netDialer({ [PUB4]: tport });
    const byTime = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { maxConnectionMs: 600 } });
    const byBytes = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { maxResponseBytes: 5 } });
    const ctl = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      const t = await rawConnect(byTime, "trickle.test:443", byTime.authHeader);
      const b = await rawConnect(byBytes, "trickle.test:443", byBytes.authHeader);
      let ctlBytes = -1;
      const c = rawConnect(ctl, "trickle.test:443", ctl.authHeader, (s) => setTimeout(() => s.destroy(), 1500));
      const cr = await c;
      ctlBytes = cr.bytes;
      artifact.tunnel_limits = { by_time: t, by_bytes: b, control: cr, log_time: brief(byTime.log), log_bytes: brief(byBytes.log) };
      expect(t.status).toBe(200);
      expect(t.closedMs).toBeGreaterThanOrEqual(550);
      expect(t.closedMs).toBeLessThan(1400);
      expect(byTime.log.some((l) => l.decision === "limit" && l.reason.startsWith("maxConnectionMs"))).toBe(true);
      expect(b.bytes).toBeLessThanOrEqual(6);
      expect(byBytes.log.some((l) => l.decision === "limit" && l.reason.startsWith("maxResponseBytes"))).toBe(true);
      expect(cr.closedMs).toBeGreaterThanOrEqual(1400); // контроль: закрив клієнт, не проксі
      expect(ctlBytes).toBeGreaterThan(10);
    } finally {
      await byTime.close();
      await byBytes.close();
      await ctl.close();
    }
  });

  it("idleTimeoutMs і connectTimeoutMs: мовчазний upstream і «чорна діра» → обрив/502 у межах ліміту", async () => {
    const r = resolverOf({ "silent.test": [PUB4], "hole.test": ["8.8.8.8"] });
    const d = netDialer({ [PUB4]: bigPort, "8.8.8.8": "hang" });
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { idleTimeoutMs: 400, connectTimeoutMs: 300 } });
    try {
      const t0 = Date.now();
      const silent = await httpGet(p, "http://silent.test/silent");
      const silentMs = Date.now() - t0;
      const t1 = Date.now();
      const hole = await rawConnect(p, "hole.test:443", p.authHeader);
      const holeMs = Date.now() - t1;
      artifact.timeouts = { silent, silent_ms: silentMs, hole, hole_ms: holeMs, log: brief(p.log) };
      expect(silent.status).toBe(502);
      expect(silentMs).toBeLessThan(2000);
      expect(p.log.some((l) => l.decision === "limit" && l.reason.startsWith("idleTimeoutMs"))).toBe(true);
      expect(hole.status).toBe(502);
      expect(holeMs).toBeLessThan(1500);
      expect(p.log.some((l) => l.decision === "error" && /connect timeout/.test(l.reason))).toBe(true);
    } finally {
      await p.close();
    }
  });

  it("maxConnections: понад ліміт одночасних з'єднань — розрив і запис; контроль: ліміт 10 → усі 3 працюють", async () => {
    const tport = (trickle.address() as AddressInfo).port;
    const r = resolverOf({ "trickle.test": [PUB4] });
    const d = netDialer({ [PUB4]: tport });
    const run = async (max: number) => {
      const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, limits: { maxConnections: max } });
      const results = await Promise.all([0, 1, 2].map(() => rawConnect(p, "trickle.test:443", p.authHeader, (s) => setTimeout(() => s.destroy(), 400))));
      await p.close();
      return { statuses: results.map((x) => x.status).sort(), log: brief(p.log) };
    };
    const limited = await run(2);
    const ctl = await run(10);
    artifact.max_connections = { limited, control: ctl };
    expect(limited.statuses).toEqual([0, 200, 200]);
    expect(limited.log.filter((l) => l.decision === "limit" && l.reason.startsWith("maxConnections"))).toHaveLength(1);
    expect(ctl.statuses).toEqual([200, 200, 200]);
  });
});

describe("IPv6 / happy eyeballs", () => {
  it("недосяжна перша (IPv6) → наступна перевірена (IPv4); змішаний публічний v6 + приватний v4 → відмова без TCP", async () => {
    const r = resolverOf({ "dual.test": [PUB6, PUB4], "v6only.test": [PUB6], "mixed.test": [PUB6, "10.0.0.1"], "mixed2.test": [PUB4, "fd00::1"] });
    const d = netDialer({ [PUB6_CANON]: "dead", [PUB4]: echoPort });
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      const dual = await rawConnect(p, "dual.test:443", p.authHeader, (s) => s.destroy());
      const v6only = await rawConnect(p, "v6only.test:443", p.authHeader);
      const callsBefore = d.calls.length;
      const mixed = await rawConnect(p, "mixed.test:443", p.authHeader);
      const mixed2 = await rawConnect(p, "mixed2.test:443", p.authHeader);
      artifact.happy_eyeballs = { dual, v6only, mixed, mixed2, dial_calls: d.calls, log: brief(p.log) };
      expect(dual.status).toBe(200);
      const allow = p.log.find((l) => l.host === "dual.test" && l.decision === "allow")!;
      expect(allow.connected_ip).toBe(PUB4);
      expect(allow.dial_failures?.map((f) => f.ip)).toEqual([PUB6_CANON]);
      expect(v6only.status).toBe(502);
      expect(mixed.status).toBe(403);
      expect(mixed2.status).toBe(403);
      expect(d.calls.length).toBe(callsBefore); // жодної спроби TCP для змішаних
      expect(r.calls.filter((h) => h === "dual.test")).toHaveLength(1); // fallback без повторного резолву
    } finally {
      await p.close();
    }
  });
});

describe("SITE_DENYLIST (G0-13)", () => {
  const secret = "hidden-s66-shop.example";
  const hash = createHash("sha256").update(secret).digest("hex");

  it("парсинг і збіг: хост, піддомен, www, URL, sha256; контроль — схожі імена не збігаються, порожній список пропускає", () => {
    const l = parseSiteDenylist(`denied.example, https://www.other.example/path\nsha256:${hash}`);
    expect(matchSiteDenylist("denied.example", l)).toBe("denied.example");
    expect(matchSiteDenylist("shop.denied.example.", l)).toBe("denied.example");
    expect(matchSiteDenylist("WWW.OTHER.EXAMPLE", l)).toBe("other.example");
    expect(matchSiteDenylist(`cdn.${secret}`, l)).toMatch(/^sha256:/);
    expect(matchSiteDenylist("notdenied.example", l)).toBeNull();
    expect(matchSiteDenylist("denied.example.evil.test", l)).toBeNull();
    expect(matchSiteDenylist("denied.example", parseSiteDenylist(""))).toBeNull();
    expect(() => parseSiteDenylist("localhost")).toThrow(/некоректний/);
    expect(() => assertSiteAllowed("https://shop.denied.example/p", l)).toThrow(/SITELENS_SITE_DENYLIST/);
    expect(() => assertSiteAllowed("https://allowed.example/p", l)).not.toThrow();
  });

  it("isSiteDenied (для scripts/audit-live.ts): URL і хост, env-список, fail-closed на зламаному URL; контроль — порожній список і схожі імена → false", () => {
    const l = parseSiteDenylist(`denied.example sha256:${hash}`);
    expect(isSiteDenied("https://shop.denied.example/x?y=1", l)).toBe(true);
    expect(isSiteDenied("DENIED.EXAMPLE.", l)).toBe(true);
    expect(isSiteDenied(`https://www.${secret}/`, l)).toBe(true);
    expect(isSiteDenied("http://[::1", l)).toBe(true); // зламаний URL — fail-closed
    expect(isSiteDenied("https://notdenied.example/", l)).toBe(false);
    expect(isSiteDenied("https://denied.example.evil.test/", l)).toBe(false);
    expect(isSiteDenied("https://denied.example/", parseSiteDenylist(""))).toBe(false);
    const env = { [SITE_DENYLIST_ENV]: "denied.example" } as NodeJS.ProcessEnv;
    expect(isSiteDenied("https://denied.example/", loadSiteDenylist(env))).toBe(true);
    expect(isSiteDenied("https://denied.example/", loadSiteDenylist({}))).toBe(false);
  });

  it("проксі відхиляє denylist-хост ДО резолву (у т.ч. підресурси); контроль: без denylist той самий хост проходить", async () => {
    const r = resolverOf({ [secret]: [PUB4], [`img.${secret}`]: [PUB4] });
    const d = netDialer({ [PUB4]: echoPort });
    const list = parseSiteDenylist(`sha256:${hash}`);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial, siteDenylist: list });
    const ctl = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      expect((await rawConnect(p, `${secret}:443`, p.authHeader)).status).toBe(403);
      expect((await rawConnect(p, `img.${secret}:443`, p.authHeader)).status).toBe(403);
      expect(r.calls).toEqual([]);
      expect(d.calls).toEqual([]);
      expect(p.log.every((l) => l.reason.startsWith("SITE_DENYLIST"))).toBe(true);
      expect((await rawConnect(ctl, `${secret}:443`, ctl.authHeader, (s) => s.destroy())).status).toBe(200);
      artifact.site_denylist = { denied: brief(p.log).map((x) => ({ ...x, host: x.host.replace(secret, "<secret>") })), control_allow: ctl.log.length };
    } finally {
      await p.close();
      await ctl.close();
    }
  });
});
