import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type Dialer, type EgressProxy, type Resolver } from "../src/net/egress-proxy.js";
import { classifyResolved } from "../src/net/ip-classify.js";

/**
 * Проксі без DNS і без зовнішньої мережі: резолвер і дайлер ін'єктовані.
 * «Симульований інтернет»: дайлер записує, до якої IP його попросили підключитись, і фактично з'єднує з локальним
 * upstream-сервером. Отже тест бачить саме ту IP, яку проксі обрав для TCP.
 * Клієнти тут — у процесі worker (не нащадки), тому автентифікуються токеном `proxy.authHeader` (S1b).
 */

let upstream: http.Server;
let upstreamPort: number;
const upstreamHits: Array<{ method: string; url: string; host: string | undefined }> = [];
let echo: net.Server;
let echoPort: number;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push({ method: req.method ?? "?", url: req.url ?? "", host: req.headers.host });
    res.writeHead(200, { "content-type": "text/plain" }).end("upstream-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => echo.close(r));
});

function recordingDialer(target: () => number) {
  const calls: Array<{ ip: string; port: number }> = [];
  const dial: Dialer = (ip, port) => {
    calls.push({ ip, port });
    return net.connect({ host: "127.0.0.1", port: target() });
  };
  return { calls, dial };
}

function mockResolver(table: Record<string, string[] | (() => string[])>) {
  const calls: string[] = [];
  const resolver: Resolver = async (h) => {
    calls.push(h);
    const e = table[h];
    if (!e) throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
    const list = typeof e === "function" ? e() : e;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
  };
  return { calls, resolver };
}

/** Сирий CONNECT: повертає статус і (для 200) відповідь echo на «ping». */
function connectVia(proxy: EgressProxy, target: string): Promise<{ status: number; echoed: string | null }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, "127.0.0.1");
    let buf = "";
    let tunneled = false;
    s.on("data", (d) => {
      buf += d.toString();
      if (!tunneled) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0);
        if (status !== 200) {
          s.destroy();
          resolve({ status, echoed: null });
          return;
        }
        tunneled = true;
        buf = buf.slice(end + 4);
        s.write("ping");
      }
      if (tunneled && buf.includes("ping")) {
        s.destroy();
        resolve({ status: 200, echoed: "ping" });
      }
    });
    s.on("error", reject);
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${proxy.authHeader}\r\n\r\n`);
  });
}

function httpVia(proxy: EgressProxy, url: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, method, path: url, headers: { host: url.startsWith("http") ? new URL(url).host : "127.0.0.1", "proxy-authorization": proxy.authHeader } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("egress-проксі: резолв → перевірка всіх A/AAAA → TCP до перевіреної IP", () => {
  it("CONNECT: публічне ім'я → 1 резолв, TCP саме до перевіреної IP, тунель працює", async () => {
    const r = mockResolver({ "public.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    const d = recordingDialer(() => echoPort);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      const res = await connectVia(p, "public.test:443");
      expect(res).toEqual({ status: 200, echoed: "ping" });
      expect(r.calls).toEqual(["public.test"]);
      expect(d.calls).toEqual([{ ip: "93.184.216.34", port: 443 }]);
      expect(p.log.at(-1)).toMatchObject({ decision: "allow", connected_ip: "93.184.216.34", via: "connect" });
    } finally {
      await p.close();
    }
  });

  it("DNS rebinding (резолвер: 1-й раз публічна, далі 127.0.0.1): наївний «перевір, потім підключись за ім'ям» FAIL, наш проксі PASS", async () => {
    const mkRebinding = () => {
      let n = 0;
      return mockResolver({ "rebind.test": () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]) });
    };
    // Предикат: IP, до якої відкрито TCP, дорівнює IP, яку перевірено, і вона дозволена.
    const pinned = (checked: string, dialed: string) => checked === dialed && classifyResolved(dialed).allowed;

    // Поганий вхід: наївна реалізація (перевірка резолвом, підключення — повторним резолвом імені).
    const naive = mkRebinding();
    const checked = (await naive.resolver("rebind.test"))[0]!.address;
    const dialedByNaive = (await naive.resolver("rebind.test"))[0]!.address;
    expect(classifyResolved(checked).allowed).toBe(true);
    expect(pinned(checked, dialedByNaive)).toBe(false); // FAIL: пішов би на 127.0.0.1

    const good = mkRebinding();
    const d = recordingDialer(() => echoPort);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: good.resolver, dial: d.dial });
    try {
      expect((await connectVia(p, "rebind.test:443")).status).toBe(200);
      expect(good.calls).toHaveLength(1); // без повторного резолву
      expect(pinned("93.184.216.34", d.calls[0]!.ip)).toBe(true); // PASS
    } finally {
      await p.close();
    }
  });

  it("змішані записи: одна заблокована A/AAAA серед публічних → відмова цілком (контроль: «лише перша адреса» пропустив би)", async () => {
    const cases: Record<string, string[]> = {
      "mixed4.test": ["93.184.216.34", "10.0.0.1"],
      "mixed6.test": ["2606:4700:4700::1111", "::1"],
      "mapped.test": ["93.184.216.34", "::ffff:169.254.169.254"],
      "nat64.test": ["64:ff9b::a9fe:a9fe"],
    };
    const firstOnly = (ips: string[]) => classifyResolved(ips[0]!).allowed;
    expect(firstOnly(cases["mixed4.test"]!)).toBe(true); // FAIL наївного варіанта
    const r = mockResolver(cases);
    const d = recordingDialer(() => echoPort);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      for (const h of Object.keys(cases)) expect((await connectVia(p, `${h}:443`)).status, h).toBe(403);
      expect(d.calls).toEqual([]); // жодного TCP
      expect(p.log.filter((l) => l.decision === "deny")).toHaveLength(4);
    } finally {
      await p.close();
    }
  });

  it("CONNECT до IP-літералів у будь-якому записі і до metadata-імен → 403 без резолву й без TCP", async () => {
    const r = mockResolver({});
    const d = recordingDialer(() => echoPort);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    try {
      for (const t of ["127.0.0.2:4199", "2130706433:443", "0x7f.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443", "169.254.169.254:80", "10.0.0.1:443", "metadata.google.internal:80", "localhost:443", "[fd00:ec2::254]:80"]) {
        expect((await connectVia(p, t)).status, t).toBe(403);
      }
      expect(r.calls).toEqual([]);
      expect(d.calls).toEqual([]);
    } finally {
      await p.close();
    }
  });

  it("plain HTTP absolute-URI: дозволена ціль проксюється з оригінальним Host і TCP до перевіреної IP; metadata → 403", async () => {
    const r = mockResolver({ "shop.test": ["93.184.216.34"] });
    const d = recordingDialer(() => upstreamPort);
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: r.resolver, dial: d.dial });
    const before = upstreamHits.length;
    try {
      const ok = await httpVia(p, "http://shop.test/page?x=1");
      expect(ok).toEqual({ status: 200, body: "upstream-ok" });
      expect(upstreamHits.slice(before)).toEqual([{ method: "GET", url: "/page?x=1", host: "shop.test" }]);
      expect(d.calls).toEqual([{ ip: "93.184.216.34", port: 80 }]);
      const bad = await httpVia(p, "http://169.254.169.254/latest/meta-data/");
      expect(bad.status).toBe(403);
      const bad2 = await httpVia(p, "http://[64:ff9b::a9fe:a9fe]/");
      expect(bad2.status).toBe(403);
      expect(d.calls).toHaveLength(1);
      expect(upstreamHits.length - before).toBe(1);
      // прямий (не-proxy) запит до проксі відкидається
      const direct = await httpVia(p, "/");
      expect(direct.status).toBe(400);
    } finally {
      await p.close();
    }
  });

  it("fixture-режим: дозволено рівно allow-list host:port; prod блокує той самий loopback; конфіг-помилки — виняток", async () => {
    const d = recordingDialer(() => upstreamPort);
    const fx = await startEgressProxy({ mode: { kind: "fixture", allow: [`127.0.0.1:${upstreamPort}`], allowFixtureLoopback: true }, dial: d.dial, resolver: mockResolver({}).resolver });
    const prod = await startEgressProxy({ mode: { kind: "prod" }, dial: d.dial, resolver: mockResolver({}).resolver });
    try {
      expect((await httpVia(fx, `http://127.0.0.1:${upstreamPort}/a`)).status).toBe(200);
      expect((await httpVia(fx, `http://127.0.0.1:${upstreamPort + 1}/a`)).status).toBe(403);
      expect((await httpVia(fx, `http://127.0.0.2:4199/`)).status).toBe(403);
      expect((await httpVia(fx, `http://2130706433:${upstreamPort}/`)).status).toBe(200); // той самий 127.0.0.1 іншим записом
      expect((await httpVia(prod, `http://127.0.0.1:${upstreamPort}/a`)).status).toBe(403);
    } finally {
      await fx.close();
      await prod.close();
    }
    await expect(startEgressProxy({ mode: { kind: "fixture", allow: ["10.0.0.1:80"], allowFixtureLoopback: true } })).rejects.toThrow(/лише loopback/);
    await expect(startEgressProxy({ mode: { kind: "fixture", allow: [], allowFixtureLoopback: true } })).rejects.toThrow(/без allow-list/);
    // без явного прапорця fixture-режим — виняток (навіть з валідним allow-list і NODE_ENV=test)
    const prevFx = process.env.SITELENS_FIXTURE_MODE;
    delete process.env.SITELENS_FIXTURE_MODE;
    try {
      await expect(startEgressProxy({ mode: { kind: "fixture", allow: ["127.0.0.1:1"] } })).rejects.toThrow(/прапорець/);
      await expect(startEgressProxy({ mode: { kind: "fixture", allow: ["127.0.0.1:1"], allowFixtureLoopback: false } })).rejects.toThrow(/прапорець/);
      // env-прапорець вмикає режим, але порожній allow-list все одно виняток
      process.env.SITELENS_FIXTURE_MODE = "1";
      await expect(startEgressProxy({ mode: { kind: "fixture", allow: [] } })).rejects.toThrow(/без allow-list/);
      const p = await startEgressProxy({ mode: { kind: "fixture", allow: ["127.0.0.1:1"] } });
      await p.close();
    } finally {
      if (prevFx === undefined) delete process.env.SITELENS_FIXTURE_MODE;
      else process.env.SITELENS_FIXTURE_MODE = prevFx;
    }
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(startEgressProxy({ mode: { kind: "fixture", allow: ["127.0.0.1:1"], allowFixtureLoopback: true } })).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
