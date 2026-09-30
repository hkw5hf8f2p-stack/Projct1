/**
 * Шар 2 для Chrome Lighthouse (S1b-Fix п.4, critic S1b-4; DEV-12, DEV-51).
 *
 * У Chrome, яким керує Lighthouse, немає Playwright `context.route`, а на HTTPS egress-проксі бачить лише CONNECT —
 * метод запиту непомітний. Тому окреме CDP-з'єднання до того самого Chrome (порт chrome-launcher):
 *   - browser-рівень `Target.setAutoAttach{autoAttach, waitForDebuggerOnStart, flatten}` → кожна вкладка, SharedWorker,
 *     Service Worker стартує ПРИЗУПИНЕНОЮ, доки ми не ввімкнули перехоплення;
 *   - на кожній сесії: `Fetch.enable{patterns:[{urlPattern:"*", requestStage:"Request"}]}`, рекурсивний auto-attach
 *     (OOPIF-iframe, dedicated Worker), потім `Runtime.runIfWaitingForDebugger`;
 *   - `Fetch.requestPaused`: GET/HEAD → continueRequest; інший метод → failRequest(BlockedByClient) + запис у `blocked`.
 * Fail-closed: якщо підключитися/увімкнути не вдалося — виняток (Lighthouse не запускається без guard).
 * Не захищає від мережі, яку Chrome робить поза Fetch-доменом (напр. DNS-prefetch/preconnect — вони і так без методу).
 */
import http from "node:http";

export interface CdpBlocked {
  ts: string;
  kind: "method";
  method: string;
  url: string;
  resource_type: string | null;
  target_type: string;
  reason: string;
}

export interface MethodGuard {
  blocked: CdpBlocked[];
  /** Типи цілей, до яких guard приєднався (page, iframe, worker, shared_worker, service_worker …). */
  attached: Array<{ type: string; url: string }>;
  /** Кількість перехоплених запитів (усіх методів) — доказ, що перехоплення взагалі працювало. */
  intercepted: number;
  errors: string[];
  close(): Promise<void>;
}

interface CdpMsg { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } }

const SAFE = new Set(["GET", "HEAD"]);

function browserWsUrl(port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: timeoutMs }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (b += d));
      res.on("end", () => {
        try {
          const u = (JSON.parse(b) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
          if (!u) throw new Error("немає webSocketDebuggerUrl");
          resolve(u);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP /json/version timeout")));
    req.on("error", reject);
  });
}

export async function attachMethodGuard(port: number, o: { timeoutMs?: number } = {}): Promise<MethodGuard> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const wsUrl = await browserWsUrl(port, timeoutMs);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP WebSocket: timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP WebSocket: помилка з'єднання")); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const sessionType = new Map<string, string>();
  const inflight: Array<Promise<void>> = [];
  const g: MethodGuard = {
    blocked: [],
    attached: [],
    intercepted: 0,
    errors: [],
    async close() {
      for (const p of pending.values()) p.reject(new Error("guard closed"));
      pending.clear();
      try { ws.close(); } catch { /* вже закрито */ }
    },
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error(`CDP closed (${method})`));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  const soft = (p: Promise<unknown>, what: string) => p.catch((e: Error) => { if (!/closed|No target|Target closed|not found/i.test(e.message)) g.errors.push(`${what}: ${e.message}`); });

  async function onAttached(params: Record<string, unknown>) {
    const sessionId = params.sessionId as string;
    const info = params.targetInfo as { type: string; url: string };
    sessionType.set(sessionId, info.type);
    g.attached.push({ type: info.type, url: info.url });
    // Fetch — до відпуску цілі: перший же запит уже перехоплюється. У dedicated Worker домену Fetch немає: його мережу
    // перехоплює Fetch батьківської сторінки/iframe (доведено: POST із Worker заблоковано з target_type=page).
    if (info.type !== "worker") await soft(send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId), `Fetch.enable ${info.type}`);
    await soft(send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId), `setAutoAttach ${info.type}`);
    if (params.waitingForDebugger) await soft(send("Runtime.runIfWaitingForDebugger", {}, sessionId), `resume ${info.type}`);
  }

  function onPaused(params: Record<string, unknown>, sessionId: string) {
    g.intercepted++;
    const req = params.request as { method: string; url: string };
    const requestId = params.requestId as string;
    const method = req.method.toUpperCase();
    if (SAFE.has(method)) return void soft(send("Fetch.continueRequest", { requestId }, sessionId), "continueRequest");
    g.blocked.push({
      ts: new Date().toISOString(),
      kind: "method",
      method,
      url: req.url,
      resource_type: (params.resourceType as string) ?? null,
      target_type: sessionType.get(sessionId) ?? "?",
      reason: "не-GET/HEAD заблоковано в Chrome Lighthouse (CDP Fetch, DEV-51)",
    });
    void soft(send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId), "failRequest");
  }

  ws.addEventListener("message", (ev: MessageEvent) => {
    let m: CdpMsg;
    try {
      m = JSON.parse(String(ev.data)) as CdpMsg;
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method === "Target.attachedToTarget" && m.params) inflight.push(onAttached(m.params));
    else if (m.method === "Fetch.requestPaused" && m.params && m.sessionId) onPaused(m.params, m.sessionId);
    else if (m.method === "Target.detachedFromTarget" && m.params) sessionType.delete(m.params.sessionId as string);
  });

  // Fail-closed: browser-рівень auto-attach мусить увімкнутись, інакше guard не діє.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await Promise.all(inflight); // уже відкриті вкладки (about:blank chrome-launcher) — Fetch увімкнено до старту Lighthouse
  return g;
}
