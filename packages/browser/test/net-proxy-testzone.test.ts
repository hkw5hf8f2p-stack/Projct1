/**
 * DEV-74: нейтральні хости сліпого прогону E3c (`site-a.test`, `site-b.test`) у fixture-режимі egress-проксі.
 * Дозвіл — лише для імен зони `.test` (RFC 6761) і лише якщо резолвер повертає ВИКЛЮЧНО loopback. Кожне правило показано
 * на позитиві й негативі: інше ім'я, публічна/приватна адреса, інший порт, prod-режим, відсутність резолву.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressProxy, type Resolver } from "../src/net/egress-proxy.js";

let upstream: http.Server;
let port: number;
const hits: string[] = [];
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    hits.push(String(req.headers.host));
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => upstream.close(r));
});

const resolverOf = (t: Record<string, string[]>): Resolver => async (h) => {
  const e = t[h];
  if (!e) throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
  return e.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
};
const via = (p: EgressProxy, url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p.port, method: "GET", path: url, headers: { host: new URL(url).host, "proxy-authorization": p.authHeader } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
const dialLocal = () => net.connect({ host: "127.0.0.1", port });

describe("fixture allow-list: імена зони .test (DEV-74)", () => {
  it("site-a.test:PORT → loopback дозволено, запит доходить до upstream з Host=site-a.test:PORT", async () => {
    const p = await startEgressProxy({ mode: { kind: "fixture", allow: [`site-a.test:${port}`], allowFixtureLoopback: true }, resolver: resolverOf({ "site-a.test": ["127.0.0.1"] }), dial: dialLocal });
    try {
      hits.length = 0;
      expect(await via(p, `http://site-a.test:${port}/x`)).toBe(200);
      expect(hits).toEqual([`site-a.test:${port}`]);
      expect(p.log.at(-1)).toMatchObject({ decision: "allow", connected_ip: "127.0.0.1" });
    } finally {
      await p.close();
    }
  });
  it("НЕГАТИВ: ім'я .test, що резолвиться не в loopback (приватна/публічна/змішана) → 403, TCP не відкривається", async () => {
    for (const [name, addrs] of [["site-a.test", ["10.0.0.5"]], ["site-a.test", ["93.184.216.34"]], ["site-a.test", ["127.0.0.1", "10.0.0.5"]], ["site-a.test", ["169.254.169.254"]]] as const) {
      let dialed = 0;
      const p = await startEgressProxy({ mode: { kind: "fixture", allow: [`${name}:${port}`], allowFixtureLoopback: true }, resolver: resolverOf({ [name]: [...addrs] }), dial: () => (dialed++, dialLocal()) });
      try {
        expect(await via(p, `http://${name}:${port}/`), addrs.join(",")).toBe(403);
        expect(dialed).toBe(0);
      } finally {
        await p.close();
      }
    }
  });
  it("НЕГАТИВ: інший порт, інше .test-ім'я, не-.test ім'я — 403; ім'я без резолву — 403", async () => {
    let dialed = 0;
    const p = await startEgressProxy({
      mode: { kind: "fixture", allow: [`site-a.test:${port}`], allowFixtureLoopback: true },
      resolver: resolverOf({ "site-a.test": ["127.0.0.1"], "site-b.test": ["127.0.0.1"], "evil.example": ["127.0.0.1"] }),
      dial: () => (dialed++, dialLocal()),
    });
    try {
      expect(await via(p, `http://site-a.test:${port + 1}/`)).toBe(403);
      expect(await via(p, `http://site-b.test:${port}/`)).toBe(403);
      expect(await via(p, `http://evil.example:${port}/`)).toBe(403);
      expect(dialed).toBe(0);
    } finally {
      await p.close();
    }
    const nores = await startEgressProxy({ mode: { kind: "fixture", allow: [`site-a.test:${port}`], allowFixtureLoopback: true }, resolver: resolverOf({}), dial: dialLocal });
    try {
      expect(await via(nores, `http://site-a.test:${port}/`)).toBe(403);
    } finally {
      await nores.close();
    }
  });
  it("prod-режим: те саме ім'я, що резолвиться в loopback, заблоковано (виняток діє лише у fixture)", async () => {
    const p = await startEgressProxy({ mode: { kind: "prod" }, resolver: resolverOf({ "site-a.test": ["127.0.0.1"] }), dial: dialLocal });
    try {
      expect(await via(p, `http://site-a.test:${port}/`)).toBe(403);
    } finally {
      await p.close();
    }
  });
  it("конфіг: у allow-list дозволено лише loopback-літерали, localhost і <name>.test; решта — виняток", async () => {
    for (const bad of ["example.com:80", "evil.test.example.com:80", "a.b.test:80", "-x.test:80", "10.0.0.1:80", "test:80"]) {
      await expect(startEgressProxy({ mode: { kind: "fixture", allow: [bad], allowFixtureLoopback: true } }), bad).rejects.toThrow(/loopback/);
    }
    const ok = await startEgressProxy({ mode: { kind: "fixture", allow: ["site-b.test:4214"], allowFixtureLoopback: true } });
    await ok.close();
  });
});
