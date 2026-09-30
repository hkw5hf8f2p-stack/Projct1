/**
 * ВІДОМЕ ОБМЕЖЕННЯ: вектор `window.open` тут НЕ використано — знайдено (S2), що popup інколи вішає `captureViewport` (S1b) до 60-с watchdog
 * (repro: scripts/s2/repro-popup-hang.ts); сам вектор покриває браузерний набір S1b (packages/browser/test/ssrf-vectors.test.ts).
 *
 * SSRF-набір S2: (1) корпус URL для ВХОДУ API (усі мають дати 400, 0 рядків, 0 звернень до канарки); (2) сторінка-атакувальник з векторами до канарки
 * 127.0.0.2:4399 для WORKER-шару (egress-проксі). Канарка лічить кожен запит (HTTP-метод+шлях) і WebSocket-апгрейд.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Canary { hits: Array<{ method: string; path: string; upgrade: boolean }>; close(): Promise<void>; port: number }
export function startCanary(port: number, host = "127.0.0.2"): Promise<Canary> {
  const hits: Canary["hits"] = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method ?? "?", path: req.url ?? "?", upgrade: false });
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end("canary");
  });
  srv.on("upgrade", (req, sock) => { hits.push({ method: "GET", path: req.url ?? "?", upgrade: true }); sock.destroy(); });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve({ hits, port: (srv.address() as AddressInfo).port, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) }));
  });
}

const LONG = Array.from({ length: 10 }, (_, i) => `<p>Абзац ${i + 1}: звичайний вміст сторінки магазину для аудиту, достатньо довгий, щоб сторінка не виглядала порожньою чи бот-стіною.</p>`).join("");

/** Усі браузерні вектори до канарки в одній сторінці. Шляхи /vNN-… унікальні → видно, який вектор дійшов. */
export function probeHtml(canary: string): string {
  const c = (id: string) => `${canary}/${id}`;
  const ws = canary.replace(/^http/, "ws");
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Тестовий магазин</title><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${c("v04-css")}"><link rel="prefetch" href="${c("v05-prefetch")}"><link rel="preload" as="fetch" href="${c("v06-preload")}" crossorigin>
<link rel="dns-prefetch" href="${canary}"><link rel="preconnect" href="${canary}">
<style>@import url(${c("v08-import.css")}); body{background:url(${c("v09-bg")})} @font-face{font-family:x;src:url(${c("v10-font")})}</style>
<script src="${c("v03-script.js")}"></script></head>
<body><main><h1>Тестовий магазин</h1>${LONG}
<img src="${c("v01-img")}" width="10" height="10" alt="x"><img srcset="${c("v02-srcset")} 1x" alt="y" width="10" height="10">
<iframe src="${c("v07-iframe")}" width="10" height="10"></iframe>
<video src="${c("v11-video")}" preload="auto"></video><audio src="${c("v12-audio")}" preload="auto"></audio><object data="${c("v13-object")}"></object><embed src="${c("v14-embed")}">
<a href="/redir">Акції</a> <a href="${c("v22-external-link")}">Зовнішнє</a>
<form id="f" method="post" action="${c("v17-form-post")}" target="fr"><input name="a" value="1"></form><iframe name="fr" width="1" height="1"></iframe>
<script>
try { fetch(${JSON.stringify(c("v15-fetch"))}, { mode: "no-cors" }); } catch (e) {}
try { const x = new XMLHttpRequest(); x.open("GET", ${JSON.stringify(c("v16-xhr"))}); x.send(); } catch (e) {}
try { navigator.sendBeacon(${JSON.stringify(c("v18-beacon"))}, "x"); } catch (e) {}
try { new WebSocket(${JSON.stringify(ws + "/v19-ws")}); } catch (e) {}
try { new EventSource(${JSON.stringify(c("v20-eventsource"))}); } catch (e) {}
try { fetch(${JSON.stringify(c("v21-fetch-post"))}, { method: "POST", mode: "no-cors", body: "x" }); } catch (e) {}
try { document.getElementById("f").submit(); } catch (e) {}
try { new Image().src = ${JSON.stringify(c("v24-new-image"))}; } catch (e) {}
</script></main></body></html>`;
}

export interface Attacker { port: number; origin: string; close(): Promise<void>; hits: string[] }
export function startAttacker(port: number, canaryOrigin: string): Promise<Attacker> {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/robots.txt") { res.writeHead(404); return void res.end("no"); }
    if (req.url === "/redir") { res.writeHead(302, { location: `${canaryOrigin}/v21-redirect` }); return void res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(probeHtml(canaryOrigin));
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve({ port, origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) }));
  });
}

/** Вхід API: усе це має бути відхилено (400). Частина — шляхи до канарки, щоб «0 звернень» було змістовним. */
export const ENTRY_CORPUS = (canaryPort: number): string[] => [
  `http://127.0.0.2:${canaryPort}/entry-v01`, `http://127.0.0.1:${canaryPort}/entry-v02`, `http://localhost:${canaryPort}/entry-v03`, `http://LOCALHOST.:${canaryPort}/entry-v04`,
  `http://2130706434:${canaryPort}/entry-v05`, `http://0177.0.0.2:${canaryPort}/entry-v06`, `http://0x7f.0.0.2:${canaryPort}/entry-v07`, `http://127.2:${canaryPort}/entry-v08`,
  `http://１２７.０.０.２:${canaryPort}/entry-v09`, `http://ⅼocalhost:${canaryPort}/entry-v10`, `http://127.0.0.2.:${canaryPort}/entry-v11`, `http://0.0.0.0:${canaryPort}/entry-v12`,
  `http://[::ffff:127.0.0.2]:${canaryPort}/entry-v13`, `http://[::1]:${canaryPort}/entry-v14`, `http://[::ffff:7f00:2]:${canaryPort}/entry-v15`, `http://[0:0:0:0:0:ffff:127.0.0.2]/entry-v16`,
  "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.0.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00:ec2::254]/",
  "http://metadata.google.internal/", "http://metadata.azure.com/", "http://instance-data/", "http://intranet/", "http://printer.local/", "http://db.internal/",
  `http://user:pw@example.com:${canaryPort}/`, `http://example.com@127.0.0.2:${canaryPort}/entry-v30`, `http://127.0.0.2%23@example.com/`,
  "file:///etc/passwd", "javascript:alert(1)", "gopher://127.0.0.2:4399/", "ftp://example.com/", "data:text/html,<script>1</script>", "not a url", "",
];
