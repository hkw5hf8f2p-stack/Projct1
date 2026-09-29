/**
 * Міні-фікстура бот-захисту й robots.txt (SPEC §48, DEV-18, DEV-39). ІМІТАЦІЯ: реальний Cloudflare відрізняється (L8 — живий пас).
 * Маршрути: `/` (посилання на решту), `/cf` (403 + cf-ray/cf-mitigated + «Just a moment...»), `/captcha` (200, reCAPTCHA, малий текст),
 * `/rate` (429 + Retry-After), `/unavail` (503), `/forbidden` (403 без cf), `/contact-ok` (НОРМАЛЬНА довга сторінка з reCAPTCHA-віджетом —
 * негативний контроль), `/private/*` (Disallow у robots.txt), `/private/open` (Allow довшим правилом), `/robots.txt`.
 */
import { startFixtureServer, type FixtureServer, type SiteHandler, type SiteResponse } from "../_shared/server.js";

/** OtherBot-група не стосується нас; `*` стосується (групи нашого UA немає). Перекриття групою SiteLensBot покрито юнітом. */
export const BOT_ROBOTS_TXT = `User-agent: OtherBot
Disallow: /

User-agent: *
Disallow: /private/
Allow: /private/open
`;

const LONG = Array.from({ length: 30 }, (_, i) => `<p>Абзац ${i + 1}: звичайний вміст сторінки контактів магазину, достатньо довгий, щоб не бути схожим на бот-стіну. Ми працюємо щодня з 9:00 до 18:00.</p>`).join("");
const html = (title: string, body: string) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;

export interface BotOptions { robots?: boolean }

export function createBotHandler(opts: BotOptions = {}): SiteHandler {
  return ({ method, url }): SiteResponse => {
    if (method !== "GET" && method !== "HEAD") return { status: 405, type: "text/plain", body: "no" };
    const p = url.pathname;
    if (p === "/robots.txt") return opts.robots === false ? { status: 404, type: "text/plain", body: "nope" } : { status: 200, type: "text/plain", body: BOT_ROBOTS_TXT };
    if (p === "/") {
      return { status: 200, logical: "home", body: html("Тест-сайт", `<main><h1>Тест-сайт</h1>${LONG}<nav><a href="/cf">Cloudflare</a> <a href="/captcha">Капча</a> <a href="/rate">Ліміт</a> <a href="/unavail">503</a> <a href="/forbidden">403</a> <a href="/contact-ok">Контакти</a> <a href="/private/secret">Закрите</a> <a href="/private/open">Відкрите</a></nav></main>`) };
    }
    if (p === "/cf") {
      return {
        status: 403,
        headers: { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-WAW", "cf-mitigated": "challenge" },
        body: html("Just a moment...", `<div id="cf-wrapper"><div id="challenge-form"><h1>Checking your browser before accessing the site.</h1><p>Enable JavaScript and cookies to continue</p><p>Ray ID: 8a1b2c3d4e5f</p></div></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`),
      };
    }
    if (p === "/captcha") return { status: 200, body: html("Перевірка", `<h1>Verify you are human</h1><div class="g-recaptcha" data-sitekey="test"></div><iframe src="https://www.google.com/recaptcha/api2/anchor" title="reCAPTCHA" width="300" height="80"></iframe>`) };
    if (p === "/rate") return { status: 429, headers: { "retry-after": "120" }, body: html("Too Many Requests", `<h1>Too Many Requests</h1><p>Спробуйте пізніше.</p>`) };
    if (p === "/unavail") return { status: 503, body: html("Service Unavailable", `<h1>503</h1><p>Сервіс тимчасово недоступний.</p>`) };
    if (p === "/forbidden") return { status: 403, body: html("Access denied", `<h1>Access denied</h1><p>Доступ заборонено.</p>`) };
    if (p === "/contact-ok") return { status: 200, logical: "contact-ok", body: html("Контакти", `<main><h1>Контакти</h1>${LONG}<div class="g-recaptcha" data-sitekey="test"></div><iframe src="https://www.google.com/recaptcha/api2/anchor" title="reCAPTCHA" width="300" height="80"></iframe></main>`) };
    if (p.startsWith("/private/")) return { status: 200, logical: p, body: html("Закрита сторінка", `<main><h1>Закрита сторінка</h1>${LONG}</main>`) };
    return { status: 404, body: html("404", "<h1>404</h1>") };
  };
}

export function startBotFixture(opts: BotOptions & { port?: number; logFile?: string } = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createBotHandler(opts), port: opts.port, logFile: opts.logFile });
}
