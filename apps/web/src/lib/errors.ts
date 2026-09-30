/** SPEC §48: 12 класів помилок (дзеркало ERROR_CLASSES із packages/schemas; звірка — у тесті) */
export const ERROR_CLASSES = [
  "invalid_url", "dns_failure", "ssl_failure", "timeout", "bot_protection", "captcha",
  "browser_crash", "page_crash", "redirect_loop", "unsupported_site", "empty_page", "js_rendering_failure",
] as const;
