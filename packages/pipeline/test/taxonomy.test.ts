/** §48: 12 класів — повідомлення (uk/en) і класифікатор на позитивних і негативних випадках. */
import { describe, expect, it } from "vitest";
import { ERROR_CLASSES, classifyCapture, classifyThrown, humanMessage, isTransient, type CaptureSignals } from "../src/taxonomy.js";

const ok = (o: Partial<CaptureSignals> = {}): CaptureSignals => ({
  navigation_completed: true, http_status: 200, content_type: "text/html", document_failures: [], visible_text_length: 2000, visible_links: 12, js_error_count: 0, console_error_count: 0,
  visible_text_sample: "Звичайна сторінка магазину", bot: { blocked: false, kind: null, signals: [] }, proxy: [], target_host: "shop.example", ...o,
});

describe("таксономія §48", () => {
  it("рівно 12 класів, кожен має непорожнє повідомлення uk і en, що містить «Аналізу немає»/«No analysis» (крім invalid_url)", () => {
    expect(ERROR_CLASSES.length).toBe(12);
    const uk = new Set<string>();
    for (const c of ERROR_CLASSES) {
      const u = humanMessage(c, "uk"), e = humanMessage(c, "en");
      expect(u.length).toBeGreaterThan(30);
      expect(e.length).toBeGreaterThan(30);
      expect(u).not.toBe(e);
      uk.add(u);
      if (c !== "invalid_url") {
        expect(u).toMatch(/Аналізу немає|аналізу немає/);
        expect(e).toMatch(/No analysis/i);
      }
    }
    expect(uk.size).toBe(12); // повідомлення різні
    expect(humanMessage("timeout", "uk", "30 с")).toMatch(/\(30 с\)$/);
  });

  it("транзієнтні: timeout, browser_crash, page_crash — так; DNS, SSL, бот — ні", () => {
    for (const c of ["timeout", "browser_crash", "page_crash"] as const) expect(isTransient(c)).toBe(true);
    for (const c of ["dns_failure", "ssl_failure", "bot_protection", "captcha", "redirect_loop", "unsupported_site", "empty_page", "js_rendering_failure", "invalid_url"] as const) expect(isTransient(c)).toBe(false);
  });

  it("норма → null (негативний контроль: здорова сторінка НЕ помилка)", () => expect(classifyCapture(ok())).toBeNull());

  const cases: Array<[string, Partial<CaptureSignals>, string]> = [
    ["DNS з рішення проксі", { navigation_completed: false, http_status: null, proxy: [{ host: "shop.example", decision: "deny", reason: "резолв не вдався: getaddrinfo ENOTFOUND" }] }, "dns_failure"],
    ["DNS з тексту помилки", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_NAME_NOT_RESOLVED"] }, "dns_failure"],
    ["SSRF-блок → invalid_url (не 403 і не бот)", { http_status: 403, proxy: [{ host: "shop.example", decision: "deny", reason: "IP-літерал 127.0.0.2 заблоковано: loopback" }] }, "invalid_url"],
    ["небезпечний порт (Chromium відмовляє сам)", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_UNSAFE_PORT"] }, "invalid_url"],
    ["SSL", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_CERT_AUTHORITY_INVALID"] }, "ssl_failure"],
    ["redirect loop", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_TOO_MANY_REDIRECTS"] }, "redirect_loop"],
    ["timeout без помилки документа", { navigation_completed: false, http_status: null }, "timeout"],
    ["з'єднання скинуто → timeout", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_EMPTY_RESPONSE"] }, "timeout"],
    ["ERR_ABORTED після ~30 с = тайм-аут навігації (Playwright скасував), не файл", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_ABORTED"], elapsed_ms: 30_500 }, "timeout"],
    ["завантаження файлу (ERR_ABORTED) → unsupported", { navigation_completed: false, http_status: null, document_failures: ["net::ERR_ABORTED"] }, "unsupported_site"],
    ["бот: cloudflare", { http_status: 403, bot: { blocked: true, kind: "cloudflare_challenge", signals: ["header:cf-mitigated=challenge"] } }, "bot_protection"],
    ["бот: 429", { http_status: 429, bot: { blocked: true, kind: "http_429", signals: [] } }, "bot_protection"],
    ["капча", { bot: { blocked: true, kind: "captcha", signals: ["dom:recaptcha"] } }, "captcha"],
    ["HTTP 500", { http_status: 500 }, "unsupported_site"],
    ["HTTP 404", { http_status: 404 }, "unsupported_site"],
    ["не HTML (pdf)", { content_type: "application/pdf" }, "unsupported_site"],
    ["порожня сторінка", { visible_text_length: 0, visible_links: 0 }, "empty_page"],
    ["JS-помилки й порожньо", { visible_text_length: 0, visible_links: 0, js_error_count: 1 }, "js_rendering_failure"],
    ["«увімкніть JavaScript» і майже порожньо", { visible_text_length: 60, visible_links: 0, visible_text_sample: "You need to enable JavaScript to run this app." }, "js_rendering_failure"],
  ];
  for (const [name, sig, cls] of cases) it(`класифікатор: ${name} → ${cls}`, () => expect(classifyCapture(ok(sig))?.errorClass).toBe(cls));

  it("порядок: проксі-deny пріоритетніший за статус/бота; бот пріоритетніший за 4xx", () => {
    expect(classifyCapture(ok({ http_status: 403, bot: { blocked: true, kind: "http_403", signals: [] }, proxy: [{ host: "shop.example", decision: "deny", reason: "заблоковано" }] }))?.errorClass).toBe("invalid_url");
    expect(classifyCapture(ok({ http_status: 403, bot: { blocked: true, kind: "http_403", signals: [] } }))?.errorClass).toBe("bot_protection");
  });
  it("рішення проксі для ІНШОГО хоста (трекер) не псує здорову сторінку", () => {
    expect(classifyCapture(ok({ proxy: [{ host: "tracker.example", decision: "deny", reason: "резолв не вдався" }] }))).toBeNull();
  });
  it("короткий, але не порожній вміст із посиланнями — не помилка", () => expect(classifyCapture(ok({ visible_text_length: 25, visible_links: 3 }))).toBeNull());

  it("виняток: page crash / browser crash / watchdog / невідоме", () => {
    expect(classifyThrown(new Error("page.evaluate: Page crashed"), { browserConnected: true }).errorClass).toBe("page_crash");
    expect(classifyThrown(new Error("page.evaluate: Target page, context or browser has been closed"), { browserConnected: false }).errorClass).toBe("browser_crash");
    expect(classifyThrown(new Error("Browser has been closed"), { browserConnected: true }).errorClass).toBe("browser_crash");
    expect(classifyThrown(new Error("capture watchdog 60s: http://x VP"), { browserConnected: true }).errorClass).toBe("timeout");
    expect(classifyThrown(new Error("щось дивне"), { browserConnected: true }).errorClass).toBe("browser_crash");
  });
});
