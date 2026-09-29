/**
 * Спільний HTTP-сервер фікстур: JSONL-лог кожного запиту (TEST_STRATEGY), лічильники станозмінних звернень
 * (GET ?add-to-cart, /logout, ?action=delete, будь-який не-GET) і більше нічого. Лише 127.0.0.1.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface SiteRequest {
  method: string;
  url: URL;
  cookies: Record<string, string>;
}
export interface SiteResponse {
  status: number;
  type?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** логічний ідентифікатор сторінки (не залежить від URL-схеми) — лише для метаморфного набору */
  logical?: string;
}
export type SiteHandler = (req: SiteRequest) => SiteResponse | null;

export interface RequestLogRow {
  ts: string;
  method: string;
  path: string;
  status: number;
  user_agent: string;
  audit_hint: string | null;
  logical: string | null;
}
export interface FixtureState {
  add_to_cart_get: number;
  logout: number;
  delete_action: number;
  non_get: number;
}
export interface FixtureServer {
  origin: string;
  log: RequestLogRow[];
  state: FixtureState;
  close: () => Promise<void>;
}

function hintFor(method: string, u: URL): string | null {
  if (method !== "GET" && method !== "HEAD") return "non_get";
  if (u.searchParams.has("add-to-cart")) return "state_change_get:add-to-cart";
  if (/^\/logout\/?$/.test(u.pathname)) return "state_change_get:logout";
  if (u.searchParams.get("action") === "delete") return "state_change_get:delete";
  return null;
}

export async function startFixtureServer(opts: { handler: SiteHandler; logFile?: string; port?: number }): Promise<FixtureServer> {
  const log: RequestLogRow[] = [];
  const state: FixtureState = { add_to_cart_get: 0, logout: 0, delete_action: 0, non_get: 0 };
  if (opts.logFile) mkdirSync(path.dirname(opts.logFile), { recursive: true });

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const u = new URL(req.url ?? "/", "http://fixture.local");
    const cookies: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const finish = (r: SiteResponse) => {
      const hint = hintFor(method, u);
      if (hint === "non_get") state.non_get++;
      if (hint === "state_change_get:add-to-cart") state.add_to_cart_get++;
      if (hint === "state_change_get:logout") state.logout++;
      if (hint === "state_change_get:delete") state.delete_action++;
      const row: RequestLogRow = {
        ts: new Date().toISOString(),
        method,
        path: u.pathname + u.search,
        status: r.status,
        user_agent: String(req.headers["user-agent"] ?? ""),
        audit_hint: hint,
        logical: r.logical ?? null,
      };
      log.push(row);
      if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify(row) + "\n");
      res.writeHead(r.status, { "content-type": r.type ?? "text/html; charset=utf-8", "cache-control": "no-store", ...(r.headers ?? {}) });
      res.end(method === "HEAD" ? undefined : r.body);
    };
    // тіло POST споживаємо й ігноруємо
    req.on("data", () => undefined);
    req.on("end", () => {
      const r = opts.handler({ method, url: u, cookies }) ?? { status: 404, type: "text/plain; charset=utf-8", body: "not found" };
      finish(r);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, log, state, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}
