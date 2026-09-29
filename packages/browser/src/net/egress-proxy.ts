/**
 * Шар 1 SSRF-захисту (G0-3, DEV-8): локальний egress-проксі — ЄДИНИЙ вихід Chromium у мережу.
 *
 * На кожне з'єднання (HTTPS CONNECT, WebSocket через CONNECT, plain HTTP absolute-URI):
 *   1. хост → статична перевірка (IP-літерал у будь-якому записі або ім'я з deny-list);
 *   2. резолв ОДИН раз → перевірка ВСІХ A/AAAA (хоч одна заблокована → відмова цілком, анти-rebinding);
 *   3. TCP саме до перевіреної IP (повторного резолву немає: `dial(ip, port)`, не `connect(hostname)`).
 * Редиректи браузер виконує новим запитом → він знову проходить через проксі (повторна валідація).
 *
 * Режими:
 *   - `prod` — loopback/private/reserved заблоковані для всього, без винятків;
 *   - `fixture` — те саме + явний allow-list `host:port` loopback-origin фікстур. Вимкнений за замовчуванням,
 *     заборонений при NODE_ENV=production. Жодного тихого фолбеку: помилка конфігурації = виняток.
 */
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { classifyHostname, classifyIpLiteral, classifyResolved, type IpVerdict } from "./ip-classify.js";

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type Dialer = (ip: string, port: number) => net.Socket;

export type ProxyMode = { kind: "prod" } | { kind: "fixture"; allow: string[] };

export interface ProxyDecision {
  ts: string;
  via: "connect" | "http";
  method: string;
  host: string;
  port: number;
  /** Усі адреси від резолвера (для IP-літерала — сам літерал). */
  resolved: IpVerdict[];
  decision: "allow" | "deny" | "error";
  reason: string;
  /** IP, до якої реально відкрито TCP (лише для allow). */
  connected_ip: string | null;
  /** Для plain HTTP — шлях (для CONNECT шлях не видно). */
  path?: string;
}

export interface EgressProxyOptions {
  mode: ProxyMode;
  /** Ін'єкція резолвера (тести, rebinding). За замовчуванням — `dns.lookup(all, verbatim)`. */
  resolver?: Resolver;
  /** Ін'єкція TCP-дайлера (тести: «симульований інтернет»). Отримує ЛИШЕ перевірену IP. */
  dial?: Dialer;
  connectTimeoutMs?: number;
  onDecision?: (d: ProxyDecision) => void;
}

export interface EgressProxy {
  url: string;
  port: number;
  mode: ProxyMode;
  log: ProxyDecision[];
  close(): Promise<void>;
}

export const defaultResolver: Resolver = async (hostname) => {
  const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return r.map((x) => ({ address: x.address, family: x.family === 6 ? 6 : 4 }));
};
const defaultDial: Dialer = (ip, port) => net.connect({ host: ip, port });

const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"];

function normalizeAllowEntry(e: string): string {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(e.trim().toLowerCase());
  if (!m) throw new Error(`fixture allow-list: очікується host:port, отримано «${e}»`);
  const host = m[1]!.replace(/^\[|\]$/g, "");
  if (host === "localhost") return `localhost:${m[2]}`;
  const lit = classifyIpLiteral(host);
  if (!lit || (lit.range !== "127.0.0.0/8" && lit.range !== "::1/128"))
    throw new Error(`fixture allow-list дозволяє лише loopback host:port, отримано «${e}»`);
  return `${lit.ip}:${m[2]}`;
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const resolver = opts.resolver ?? defaultResolver;
  const dial = opts.dial ?? defaultDial;
  const timeout = opts.connectTimeoutMs ?? 10_000;
  let allow = new Set<string>();
  if (opts.mode.kind === "fixture") {
    if (process.env.NODE_ENV === "production") throw new Error("egress-proxy: fixture-режим заборонено при NODE_ENV=production");
    if (opts.mode.allow.length === 0) throw new Error("egress-proxy: fixture-режим без allow-list — використай prod");
    allow = new Set(opts.mode.allow.map(normalizeAllowEntry));
  } else if (opts.mode.kind !== "prod") {
    throw new Error("egress-proxy: невідомий режим");
  }
  const log: ProxyDecision[] = [];
  const record = (d: ProxyDecision) => {
    log.push(d);
    opts.onDecision?.(d);
  };

  /** Рішення за хостом: повертає перевірену IP для підключення або причину відмови. Резолв рівно один. */
  async function decide(hostRaw: string, port: number): Promise<{ ok: true; ip: string; resolved: IpVerdict[] } | { ok: false; reason: string; resolved: IpVerdict[] }> {
    const host = hostRaw.replace(/^\[|\]$/g, "").toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "некоректний порт", resolved: [] };
    const allowKey = `${host}:${port}`;
    const lit = classifyIpLiteral(host);
    if (lit) {
      if (lit.allowed) return { ok: true, ip: lit.ip, resolved: [lit] };
      if (allow.has(`${lit.ip}:${port}`)) return { ok: true, ip: lit.ip, resolved: [lit] };
      return { ok: false, reason: `IP-літерал ${lit.ip} заблоковано: ${lit.range} ${lit.reason}`, resolved: [lit] };
    }
    const hn = classifyHostname(host);
    const fixtureName = allow.has(allowKey);
    if (!hn.allowed && !fixtureName) return { ok: false, reason: hn.reason, resolved: [] };
    let addrs: ResolvedAddress[];
    try {
      addrs = await resolver(host);
    } catch (e) {
      return { ok: false, reason: `резолв не вдався: ${(e as Error).message}`, resolved: [] };
    }
    if (addrs.length === 0) return { ok: false, reason: "резолвер не повернув адрес", resolved: [] };
    const verdicts = addrs.map((a) => classifyResolved(a.address, a.family));
    if (fixtureName) {
      // Фікстурне ім'я (напр. localhost:port) — дозволено лише якщо ВСІ адреси loopback.
      const bad = verdicts.find((v) => v.range !== "127.0.0.0/8" && v.range !== "::1/128");
      if (bad) return { ok: false, reason: `фікстурне ім'я ${host} резолвиться не в loopback (${bad.ip})`, resolved: verdicts };
      return { ok: true, ip: verdicts[0]!.ip, resolved: verdicts };
    }
    const blocked = verdicts.find((v) => !v.allowed);
    if (blocked) return { ok: false, reason: `серед A/AAAA є заблокована ${blocked.ip}: ${blocked.range} ${blocked.reason}`, resolved: verdicts };
    return { ok: true, ip: verdicts[0]!.ip, resolved: verdicts };
  }

  function dialChecked(ip: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = dial(ip, port);
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error("connect timeout"));
      }, timeout);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  const server = http.createServer();
  const sockets = new Set<Duplex>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  // HTTPS / WSS / WS-через-проксі: CONNECT host:port
  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => {});
    const target = req.url ?? "";
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
    const base = { ts: new Date().toISOString(), via: "connect" as const, method: "CONNECT" };
    if (!m) {
      record({ ...base, host: target, port: 0, resolved: [], decision: "deny", reason: "некоректна ціль CONNECT", connected_ip: null });
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = m[1]!;
    const port = Number(m[2]);
    void (async () => {
      const d = await decide(host, port);
      if (!d.ok) {
        record({ ...base, host, port, resolved: d.resolved, decision: "deny", reason: d.reason, connected_ip: null });
        client.end("HTTP/1.1 403 Forbidden\r\nX-SiteLens-Egress: blocked\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      let upstream: net.Socket;
      try {
        upstream = await dialChecked(d.ip, port);
      } catch (e) {
        record({ ...base, host, port, resolved: d.resolved, decision: "error", reason: `upstream: ${(e as Error).message}`, connected_ip: d.ip });
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      record({ ...base, host, port, resolved: d.resolved, decision: "allow", reason: "усі адреси дозволені; TCP до перевіреної IP", connected_ip: d.ip });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    })();
  });

  // Plain HTTP: absolute-URI у request line
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const base = { ts: new Date().toISOString(), via: "http" as const, method: req.method ?? "?" };
    let u: URL;
    try {
      u = new URL(req.url ?? "");
      if (u.protocol !== "http:") throw new Error("scheme");
    } catch {
      record({ ...base, host: req.headers.host ?? "", port: 0, resolved: [], decision: "deny", reason: "не absolute-URI http:// (прямий запит до проксі)", connected_ip: null });
      res.writeHead(400).end();
      return;
    }
    const host = u.hostname;
    const port = u.port === "" ? 80 : Number(u.port);
    const path = u.pathname + u.search;
    void (async () => {
      const d = await decide(host, port);
      if (!d.ok) {
        record({ ...base, host, port, path, resolved: d.resolved, decision: "deny", reason: d.reason, connected_ip: null });
        const body = "blocked by SiteLens egress proxy\n";
        res.shouldKeepAlive = false;
        res.writeHead(403, { "x-sitelens-egress": "blocked", "content-type": "text/plain", "content-length": String(body.length), connection: "close" }).end(body);
        return;
      }
      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      headers.host = u.host;
      headers.connection = "close";
      const upReq = http.request({
        method: req.method,
        path,
        headers,
        setHost: false,
        // Без agent: інакше Node ігнорує createConnection. TCP — саме до перевіреної IP, http.request нічого не резолвить.
        host: d.ip,
        port,
        createConnection: () => dial(d.ip, port),
        timeout,
      });
      upReq.on("response", (upRes) => {
        record({ ...base, host, port, path, resolved: d.resolved, decision: "allow", reason: "усі адреси дозволені; TCP до перевіреної IP", connected_ip: d.ip });
        const out = { ...upRes.headers };
        for (const h of HOP_BY_HOP) delete out[h];
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      });
      upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
      upReq.on("error", (e) => {
        record({ ...base, host, port, path, resolved: d.resolved, decision: "error", reason: `upstream: ${e.message}`, connected_ip: d.ip });
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.pipe(upReq);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    mode: opts.mode,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
