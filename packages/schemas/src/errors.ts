/** SPEC §48: 12 класів помилок захоплення/аудиту. Єдине джерело для БД (CHECK у 002_pipeline.sql), API й worker. */
export const ERROR_CLASSES = [
  "invalid_url", "dns_failure", "ssl_failure", "timeout", "bot_protection", "captcha",
  "browser_crash", "page_crash", "redirect_loop", "unsupported_site", "empty_page", "js_rendering_failure",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const isErrorClass = (x: unknown): x is ErrorClass => typeof x === "string" && (ERROR_CLASSES as readonly string[]).includes(x);
