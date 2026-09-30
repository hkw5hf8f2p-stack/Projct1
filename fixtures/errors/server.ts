/**
 * Фікстура збоїв SPEC §48 для S2 (маршрут на клас). ІМІТАЦІЇ; реальні сайти поводяться складніше (live pass ⏭️).
 *   /ok, /ok-b, /ok-c      нормальні сторінки (контроль: аналіз є)
 *   /partial               головна «частково зламаного» сайту: посилання на /ok-b, /ok-c і /e/500 (аудит має завершитись із позначками)
 *   /e/timeout             сервер приймає запит і ніколи не відповідає (навігація 30 с → timeout)
 *   /e/500, /e/404         HTTP-помилка (→ unsupported_site)
 *   /e/pdf                 application/pdf (→ unsupported_site)
 *   /e/empty               200, порожнє тіло (→ empty_page)
 *   /e/js-broken           200, порожній #app + виняток у скрипті (→ js_rendering_failure)
 *   /e/redirect-loop       302 → /e/redirect-loop2 → 302 → /e/redirect-loop (→ redirect_loop)
 *   /e/captcha, /e/cf      імітація капчі / Cloudflare-challenge (→ captcha / bot_protection)
 *   /e/crash               намагається обвалити рендерер (пам'ять) → page_crash (найкращі зусилля; див. тест)
 *   HTTPS (самопідписаний сертифікат, openssl) на окремому порту → ssl_failure. `.invalid`-хост → dns_failure (сервер не потрібен).
 * Лічильники: `hits` (усі запити) і `non_get` — сервер нічого не змінює.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const LOREM = Array.from({ length: 8 }, (_, i) => `<p>Абзац ${i + 1}. Це звичайна сторінка тестового магазину: опис товарів, умови доставки та оплати, контакти. Ми відповідаємо щодня з 9:00 до 18:00.</p>`).join("");
const page = (title: string, body: string) =>
  `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header><nav><a href="/">Головна</a></nav></header><main><h1>${title}</h1>${LOREM}${body}</main><footer>© тест</footer></body></html>`;

export interface ErrorsFixture {
  origin: string;
  httpsOrigin: string;
  hits: string[];
  state: { non_get: number };
  close(): Promise<void>;
}

export async function startErrorsFixture(o: { port?: number; httpsPort?: number } = {}): Promise<ErrorsFixture> {
  const hits: string[] = [];
  const state = { non_get: 0 };
  const sockets = new Set<import("node:stream").Duplex>();
  const handler: http.RequestListener = (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${u.pathname}`);
    if (req.method !== "GET" && req.method !== "HEAD") state.non_get++;
    const send = (status: number, body: string, headers: Record<string, string> = {}, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
      res.end(body);
    };
    switch (u.pathname) {
      case "/": case "/ok": return send(200, page("Тестовий магазин", `<a href="/ok-b">Товари</a> <a href="/ok-c">Доставка</a><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="120">`));
      case "/ok-b": return send(200, page("Товари", `<a href="/">Назад</a>`));
      case "/ok-c": return send(200, page("Доставка і оплата", `<a href="/">Назад</a>`));
      case "/partial": return send(200, page("Частково зламаний сайт", `<nav><a href="/ok-b">Товари</a> <a href="/ok-c">Доставка</a> <a href="/e/500">Акції</a></nav><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="120">`));
      case "/e/timeout": return void 0; // навмисно без відповіді
      case "/e/500": return send(500, page("Внутрішня помилка", "<p>Щось пішло не так.</p>"));
      case "/e/404": return send(404, page("Не знайдено", ""));
      case "/e/pdf": return send(200, "%PDF-1.4 fake", {}, "application/pdf");
      case "/e/empty": return send(200, "<!doctype html><html><head><title></title></head><body></body></html>");
      case "/e/js-broken": return send(200, `<!doctype html><html><head><title>App</title></head><body><div id="app"></div><script>throw new Error("boom: render failed");</script></body></html>`);
      case "/e/redirect-loop": return send(302, "", { location: "/e/redirect-loop2" });
      case "/e/redirect-loop2": return send(302, "", { location: "/e/redirect-loop" });
      case "/e/captcha": return send(200, `<!doctype html><html><head><title>Перевірка</title></head><body><h1>Verify you are human</h1><div class="g-recaptcha" data-sitekey="test"></div><iframe src="https://www.google.com/recaptcha/api2/anchor" title="reCAPTCHA" width="300" height="80"></iframe></body></html>`);
      case "/e/cf": return send(403, `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-wrapper"><div id="challenge-form"><h1>Checking your browser before accessing the site.</h1><p>Ray ID: 8a1b2c3d4e5f</p></div></div></body></html>`, { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-WAW", "cf-mitigated": "challenge" });
      case "/e/crash": return send(200, `<!doctype html><html><head><title>Crash</title></head><body><h1>x</h1><script>const a=[];for(;;){a.push(new Array(5e6).fill(1.5));}</script></body></html>`);
      case "/robots.txt": return send(404, "no", {}, "text/plain");
      default: return send(404, page("404", ""));
    }
  };
  const httpServer = http.createServer(handler);
  httpServer.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => httpServer.listen(o.port ?? 0, "127.0.0.1", () => r()));

  const dir = mkdtempSync(path.join(os.tmpdir(), "sl-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const httpsServer = https.createServer({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, handler);
  httpsServer.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => httpsServer.listen(o.httpsPort ?? 0, "127.0.0.1", () => r()));
  return {
    origin: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    httpsOrigin: `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`,
    hits, state,
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all([new Promise<void>((r) => httpServer.close(() => r())), new Promise<void>((r) => httpsServer.close(() => r()))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
