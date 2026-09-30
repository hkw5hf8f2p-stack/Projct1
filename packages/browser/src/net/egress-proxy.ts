/**
 * Шар 1 SSRF-захисту (G0-3, DEV-8): локальний egress-проксі — ЄДИНИЙ вихід Chromium у мережу.
 *
 * На кожне з'єднання (HTTPS CONNECT, WebSocket через CONNECT, plain HTTP absolute-URI):
 *   1. хост → статична перевірка (IP-літерал у будь-якому записі або ім'я з deny-list);
 *   2. резолв ОДИН раз → перевірка ВСІХ A/AAAA (хоч одна заблокована → відмова цілком, анти-rebinding);
 *   3. TCP саме до перевіреної IP (повторного резолву немає: `dial(ip, port)`, не `connect(hostname)`).
 * Редиректи браузер виконує новим запитом → він знову проходить через проксі (повторна валідація).
 *
 * Автентифікація клієнтів (S1b): peer-check (власник сокета — нащадок worker, /proc) АБО токен у
 * `Proxy-Authorization`; без /proc (macOS) — відкритий режим із попередженням (`authMode`).
 * Ліміти (S1b): одночасні з'єднання, байти відповіді/тунелю, тривалість з'єднання, простій, таймаут заголовків.
 * Happy eyeballs: якщо перевірена адреса недосяжна, пробуємо наступну з ТОГО САМОГО перевіреного набору.
 * SITE_DENYLIST (G0-13): хости зі списку відхиляються до резолву.
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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { classifyHostname, classifyIpLiteral, classifyResolved, type IpVerdict } from "./ip-classify.js";
import { checkPeer, peerCheckAvailable } from "./peer-check.js";
import { matchSiteDenylist, type SiteDenylist } from "./site-denylist.js";

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type Dialer = (ip: string, port: number) => net.Socket;

/**
 * `fixture` вмикається лише явно: `allowFixtureLoopback: true` або env `SITELENS_FIXTURE_MODE=1` (не «NODE_ENV≠production»),
 * плюс непорожній allow-list; при NODE_ENV=production заборонений завжди.
 */
export type ProxyMode = { kind: "prod" } | { kind: "fixture"; allow: string[]; allowFixtureLoopback?: boolean };

export function fixtureModeEnabled(explicit?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return explicit === true || env.SITELENS_FIXTURE_MODE === "1";
}

export interface ProxyDecision {
  ts: string;
  via: "connect" | "http" | "tcp";
  method: string;
  host: string;
  port: number;
  /** Усі адреси від резолвера (для IP-літерала — сам літерал). */
  resolved: IpVerdict[];
  /** `limit` — з'єднання обірвано лімітом; `unauthorized` — клієнт проксі не пройшов peer-check/токен. */
  decision: "allow" | "deny" | "error" | "limit" | "unauthorized";
  reason: string;
  /** IP, до якої реально відкрито TCP (лише для allow). */
  connected_ip: string | null;
  /** Для plain HTTP — шлях (для CONNECT шлях не видно). */
  path?: string;
  /** Невдалі спроби TCP до перевірених адрес (happy eyeballs). */
  dial_failures?: Array<{ ip: string; error: string }>;
  /** Байти від upstream до клієнта (для limit/закриття). */
  bytes_down?: number;
  /** pid власника клієнтського сокета (peer-check). */
  peer_pid?: number | null;
}

export interface ProxyLimits {
  /** Одночасні клієнтські з'єднання з проксі. */
  maxConnections: number;
  /** Байти від upstream на одне з'єднання (тунель або HTTP-відповідь). */
  maxResponseBytes: number;
  /** Максимальна тривалість одного з'єднання/тунелю. */
  maxConnectionMs: number;
  /** Простій сокета (немає даних у жодному напрямку). */
  idleTimeoutMs: number;
  /** Таймаут TCP-підключення до кожної перевіреної адреси. */
  connectTimeoutMs: number;
  /** Таймаут отримання заголовків запиту клієнта. */
  headersTimeoutMs: number;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  maxConnections: 128,
  maxResponseBytes: 50 * 1024 * 1024,
  maxConnectionMs: 120_000,
  idleTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
};

/**
 * `peer-or-token` (за замовчуванням): клієнт — нащадок worker (Chromium/Lighthouse) або має токен.
 * `token` — лише токен. `open` — без перевірки (лише для контрольних тестів і платформ без /proc).
 */
export type ClientAuth = "peer-or-token" | "token" | "open";

export interface EgressProxyOptions {
  mode: ProxyMode;
  /** Ін'єкція резолвера (тести, rebinding). За замовчуванням — `dns.lookup(all, verbatim)`. */
  resolver?: Resolver;
  /** Ін'єкція TCP-дайлера (тести: «симульований інтернет»). Отримує ЛИШЕ перевірену IP. */
  dial?: Dialer;
  /** @deprecated використовуйте limits.connectTimeoutMs */
  connectTimeoutMs?: number;
  limits?: Partial<ProxyLimits>;
  clientAuth?: ClientAuth;
  /** Токен для `Proxy-Authorization: Bearer <token>` (або Basic з паролем = токен). За замовчуванням — випадковий. */
  authToken?: string;
  siteDenylist?: SiteDenylist;
  onDecision?: (d: ProxyDecision) => void;
}

export interface EgressProxy {
  url: string;
  port: number;
  mode: ProxyMode;
  log: ProxyDecision[];
  limits: ProxyLimits;
  /** Фактичний режим автентифікації (peer-or-token деградує в open без /proc — з попередженням). */
  authMode: ClientAuth;
  authWarning: string | null;
  authToken: string;
  /** Заголовок для довірених клієнтів у самому worker. */
  authHeader: string;
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
  // S4 (DEV-74): нейтральні хости сліпого прогону E3c — зарезервована зона RFC 6761 `.test` (у публічному DNS не резолвиться).
  // Дозвіл лише на ім'я; вирішує резолвер, а `decide()` вимагає, щоб УСІ адреси були loopback (інакше відмова).
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.test$/.test(host)) return `${host}:${m[2]}`;
  const lit = classifyIpLiteral(host);
  if (!lit || (lit.range !== "127.0.0.0/8" && lit.range !== "::1/128"))
    throw new Error(`fixture allow-list дозволяє лише loopback host:port, отримано «${e}»`);
  return `${lit.ip}:${m[2]}`;
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const resolver = opts.resolver ?? defaultResolver;
  const dial = opts.dial ?? defaultDial;
  const limits: ProxyLimits = { ...DEFAULT_PROXY_LIMITS, ...(opts.connectTimeoutMs ? { connectTimeoutMs: opts.connectTimeoutMs } : {}), ...opts.limits };
  const timeout = limits.connectTimeoutMs;
  const authToken = opts.authToken ?? randomBytes(24).toString("base64url");
  let authMode: ClientAuth = opts.clientAuth ?? "peer-or-token";
  let authWarning: string | null = null;
  if (authMode === "peer-or-token" && !peerCheckAvailable()) {
    authMode = "open";
    authWarning = "peer-check недоступний (немає /proc) — проксі приймає будь-який локальний процес (THREAT_MODEL T-8)";
  }
  const denylist = opts.siteDenylist;
  let allow = new Set<string>();
  if (opts.mode.kind === "fixture") {
    if (process.env.NODE_ENV === "production") throw new Error("egress-proxy: fixture-режим заборонено при NODE_ENV=production");
    if (!fixtureModeEnabled(opts.mode.allowFixtureLoopback))
      throw new Error("egress-proxy: fixture-режим вимкнений — потрібен явний прапорець allowFixtureLoopback:true або SITELENS_FIXTURE_MODE=1");
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
  async function decide(hostRaw: string, port: number): Promise<{ ok: true; ips: string[]; resolved: IpVerdict[] } | { ok: false; reason: string; resolved: IpVerdict[] }> {
    const host = hostRaw.replace(/^\[|\]$/g, "").toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "некоректний порт", resolved: [] };
    const allowKey = `${host}:${port}`;
    const lit = classifyIpLiteral(host);
    if (lit) {
      if (lit.allowed) return { ok: true, ips: [lit.ip], resolved: [lit] };
      if (allow.has(`${lit.ip}:${port}`)) return { ok: true, ips: [lit.ip], resolved: [lit] };
      return { ok: false, reason: `IP-літерал ${lit.ip} заблоковано: ${lit.range} ${lit.reason}`, resolved: [lit] };
    }
    if (denylist) {
      const hit = matchSiteDenylist(host, denylist);
      if (hit) return { ok: false, reason: `SITE_DENYLIST (${hit})`, resolved: [] };
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
      return { ok: true, ips: [...new Set(verdicts.map((v) => v.ip))], resolved: verdicts };
    }
    const blocked = verdicts.find((v) => !v.allowed);
    if (blocked) return { ok: false, reason: `серед A/AAAA є заблокована ${blocked.ip}: ${blocked.range} ${blocked.reason}`, resolved: verdicts };
    return { ok: true, ips: [...new Set(verdicts.map((v) => v.ip))], resolved: verdicts };
  }

  function dialOne(ip: string, port: number): Promise<net.Socket> {
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

  /** Happy eyeballs (послідовно): кожна спроба — лише до адреси з перевіреного набору; повторного резолву немає. */
  async function dialChecked(ips: string[], port: number): Promise<{ socket: net.Socket; ip: string; failures: Array<{ ip: string; error: string }> }> {
    const failures: Array<{ ip: string; error: string }> = [];
    for (const ip of ips) {
      try {
        return { socket: await dialOne(ip, port), ip, failures };
      } catch (e) {
        failures.push({ ip, error: (e as Error).message });
      }
    }
    throw Object.assign(new Error(failures.map((f) => `${f.ip}: ${f.error}`).join("; ") || "немає адрес"), { failures });
  }

  function tokenOk(header: string | string[] | undefined): boolean {
    if (typeof header !== "string") return false;
    let presented: string | null = null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(header);
    if (bearer) presented = bearer[1]!;
    const basic = /^Basic\s+(\S+)$/i.exec(header);
    if (basic) {
      const dec = Buffer.from(basic[1]!, "base64").toString("utf8");
      presented = dec.slice(dec.indexOf(":") + 1);
    }
    if (presented === null) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(authToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const peerOf = new WeakMap<object, { allowed: boolean; pid: number | null; reason: string }>();
  function authorize(sock: Duplex, header: string | string[] | undefined): { ok: boolean; reason: string; pid: number | null } {
    if (authMode === "open") return { ok: true, reason: "open", pid: null };
    if (tokenOk(header)) return { ok: true, reason: "token", pid: null };
    if (authMode === "token") return { ok: false, reason: "потрібен токен у Proxy-Authorization", pid: null };
    let v = peerOf.get(sock);
    if (!v) {
      const s = sock as net.Socket;
      const pv = s.remotePort ? checkPeer(s.remotePort, (server.address() as AddressInfo).port) : { allowed: false, owner_pid: null, reason: "немає remotePort" };
      v = { allowed: pv.allowed, pid: pv.owner_pid, reason: pv.reason };
      peerOf.set(sock, v);
    }
    return { ok: v.allowed, reason: v.reason, pid: v.pid };
  }

  const server = http.createServer();
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.maxConnectionMs;
  const sockets = new Set<Duplex>();
  let clientCount = 0;
  server.on("connection", (s: net.Socket) => {
    if (clientCount >= limits.maxConnections) {
      record({ ts: new Date().toISOString(), via: "tcp", method: "-", host: "", port: 0, resolved: [], decision: "limit", reason: `maxConnections ${limits.maxConnections}`, connected_ip: null });
      s.destroy();
      return;
    }
    clientCount++;
    sockets.add(s);
    // Простій клієнтського сокета: запас понад maxConnectionMs (простій upstream ріже idleTimeoutMs з 502 і записом).
    s.setTimeout(limits.maxConnectionMs + 1000, () => s.destroy());
    s.on("close", () => {
      clientCount--;
      sockets.delete(s);
    });
  });

  const unauthorized = (via: "connect" | "http", method: string, host: string, port: number, a: { reason: string; pid: number | null }) =>
    record({ ts: new Date().toISOString(), via, method, host, port, resolved: [], decision: "unauthorized", reason: `клієнт проксі відхилено: ${a.reason}`, connected_ip: null, peer_pid: a.pid });

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
    const auth = authorize(req.socket, req.headers["proxy-authorization"]);
    if (!auth.ok) {
      unauthorized("connect", "CONNECT", host, port, auth);
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm="sitelens"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    void (async () => {
      const d = await decide(host, port);
      if (!d.ok) {
        record({ ...base, host, port, resolved: d.resolved, decision: "deny", reason: d.reason, connected_ip: null });
        client.end("HTTP/1.1 403 Forbidden\r\nX-SiteLens-Egress: blocked\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      let up: Awaited<ReturnType<typeof dialChecked>>;
      try {
        up = await dialChecked(d.ips, port);
      } catch (e) {
        record({ ...base, host, port, resolved: d.resolved, decision: "error", reason: `upstream: ${(e as Error).message}`, connected_ip: null, dial_failures: (e as { failures?: Array<{ ip: string; error: string }> }).failures });
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = up.socket;
      record({ ...base, host, port, resolved: d.resolved, decision: "allow", reason: "усі адреси дозволені; TCP до перевіреної IP", connected_ip: up.ip, ...(up.failures.length ? { dial_failures: up.failures } : {}), peer_pid: auth.pid });
      sockets.add(upstream);
      let down = 0;
      let limited = false;
      const cut = (reason: string) => {
        if (limited) return;
        limited = true;
        record({ ...base, host, port, resolved: d.resolved, decision: "limit", reason, connected_ip: up.ip, bytes_down: down });
        upstream.destroy();
        client.destroy();
      };
      const life = setTimeout(() => cut(`maxConnectionMs ${limits.maxConnectionMs}`), limits.maxConnectionMs);
      upstream.setTimeout(limits.idleTimeoutMs, () => cut(`idleTimeoutMs ${limits.idleTimeoutMs}`));
      upstream.on("data", (chunk: Buffer) => {
        down += chunk.length;
        if (down > limits.maxResponseBytes) cut(`maxResponseBytes ${limits.maxResponseBytes}`);
      });
      upstream.on("close", () => {
        clearTimeout(life);
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
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
    const auth = authorize(req.socket, req.headers["proxy-authorization"]);
    if (!auth.ok) {
      unauthorized("http", req.method ?? "?", host, port, auth);
      res.shouldKeepAlive = false;
      res.writeHead(407, { "proxy-authenticate": 'Bearer realm="sitelens"', "content-length": "0", connection: "close" }).end();
      return;
    }
    void (async () => {
      const d = await decide(host, port);
      if (!d.ok) {
        record({ ...base, host, port, path, resolved: d.resolved, decision: "deny", reason: d.reason, connected_ip: null });
        const body = "blocked by SiteLens egress proxy\n";
        res.shouldKeepAlive = false;
        res.writeHead(403, { "x-sitelens-egress": "blocked", "content-type": "text/plain", "content-length": String(body.length), connection: "close" }).end(body);
        return;
      }
      let up: Awaited<ReturnType<typeof dialChecked>>;
      try {
        up = await dialChecked(d.ips, port);
      } catch (e) {
        record({ ...base, host, port, path, resolved: d.resolved, decision: "error", reason: `upstream: ${(e as Error).message}`, connected_ip: null, dial_failures: (e as { failures?: Array<{ ip: string; error: string }> }).failures });
        if (!res.headersSent) res.writeHead(502, { connection: "close" }).end();
        return;
      }
      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      headers.host = u.host;
      headers.connection = "close";
      let down = 0;
      let limited = false;
      const upReq = http.request({
        method: req.method,
        path,
        headers,
        setHost: false,
        // Без agent: інакше Node ігнорує createConnection. Сокет уже з'єднаний саме з перевіреною IP.
        host: up.ip,
        port,
        createConnection: () => up.socket,
      });
      const cut = (reason: string) => {
        if (limited) return;
        limited = true;
        record({ ...base, host, port, path, resolved: d.resolved, decision: "limit", reason, connected_ip: up.ip, bytes_down: down });
        upReq.destroy();
        if (!res.headersSent) res.writeHead(502, { connection: "close", "x-sitelens-egress": "limit" }).end();
        else res.destroy();
      };
      const life = setTimeout(() => cut(`maxConnectionMs ${limits.maxConnectionMs}`), limits.maxConnectionMs);
      res.on("close", () => clearTimeout(life));
      upReq.on("response", (upRes) => {
        const declared = Number(upRes.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
          cut(`maxResponseBytes ${limits.maxResponseBytes} (content-length ${declared})`);
          return;
        }
        record({ ...base, host, port, path, resolved: d.resolved, decision: "allow", reason: "усі адреси дозволені; TCP до перевіреної IP", connected_ip: up.ip, ...(up.failures.length ? { dial_failures: up.failures } : {}), peer_pid: auth.pid });
        const out = { ...upRes.headers };
        for (const h of HOP_BY_HOP) delete out[h];
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.on("data", (chunk: Buffer) => {
          down += chunk.length;
          if (down > limits.maxResponseBytes) cut(`maxResponseBytes ${limits.maxResponseBytes}`);
        });
        upRes.pipe(res);
      });
      // Простій upstream (сокет уже з'єднаний, тож опція `timeout` http.request не спрацьовує — ставимо явно).
      up.socket.setTimeout(limits.idleTimeoutMs, () => cut(`idleTimeoutMs ${limits.idleTimeoutMs}`));
      upReq.on("error", (e) => {
        if (limited) return;
        record({ ...base, host, port, path, resolved: d.resolved, decision: "error", reason: `upstream: ${e.message}`, connected_ip: up.ip });
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
    limits,
    authMode,
    authWarning,
    authToken,
    authHeader: `Bearer ${authToken}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
