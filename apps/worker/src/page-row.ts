/** PageCapture → рядок page_artifacts (дзеркалить pageArtifactRow із run-site.ts, S1a) + рядок для збійної сторінки (§48). */
import type { ErrorClass } from "@sitelens/schemas";
import type { PageRow } from "@sitelens/pipeline";
import { humanMessage } from "@sitelens/pipeline";
import { pageGroupOf, type PageCapture, type ViewportCapture } from "./browser-api.js";

export function pageRowOf(p: PageCapture, egressDenied: unknown[] = []): PageRow {
  const d = p.D;
  const m = p.M;
  return {
    id: p.page_id, url: p.url, page_type: p.page_type, page_type_reason: p.page_type_reason, title: d.title, http_status: d.http_status,
    desktop_screenshot: d.screenshots.fullpage.file, mobile_screenshot: m.screenshots.fullpage.file, dom_text: null, aria_snapshot: d.aria_snapshot, visible_text: d.visible_text,
    metadata_json: {
      meta_description: d.meta_description, headings: d.headings, images: d.images.map((i) => ({ src: i.current_src, alt: i.alt })), buttons: d.buttons,
      form_controls: d.form_controls, forms: d.forms, mobile: { title: m.title, headings: m.headings, buttons: m.buttons },
    },
    links_json: d.links,
    technical_json: {
      viewports: { D: [d.width, d.height, d.dpr], M: [m.width, m.height, m.dpr] },
      capture: { D: d.completeness, M: m.completeness },
      banner: { D: d.banner, M: m.banner },
      redirect_chain: { D: d.redirect_chain, M: m.redirect_chain },
      console_errors: { D: d.console_errors, M: m.console_errors },
      failed_requests: { D: d.failed_requests, M: m.failed_requests },
      axe_version: d.axe.version,
      files: { D: d.files, M: m.files },
      screenshots: { D: d.screenshots, M: m.screenshots },
      tiles: { D: d.tiles, M: m.tiles },
      page_error: null,
      response_headers: { D: d.response_headers, M: m.response_headers },
      metrics_ref: "page-capture.json",
      egress_denied: egressDenied,
    },
  };
}

/** Збійна сторінка: рядок є (0 втрат для обліку), але без вмісту й доказів — §48 «не вигадувати аналіз». */
export function failedRow(url: string, pageId: string, cls: ErrorClass, detail: string, lang: "uk" | "en", httpStatus: number | null, attempts: number, egressDenied: unknown[] = []): PageRow {
  return {
    id: pageId, url, page_type: "unknown", page_type_reason: "capture", title: null, http_status: httpStatus,
    desktop_screenshot: null, mobile_screenshot: null, dom_text: null, aria_snapshot: null, visible_text: null, metadata_json: {}, links_json: [],
    technical_json: { capture_error: { class: cls, message: humanMessage(cls, lang), detail, attempts }, page_error: null, egress_denied: egressDenied },
  };
}

/** Заглушка PageCapture для crawl() при повторі: сторінка збійна → crawl не збирає з неї посилань (як для бот-захисту в S1a). */
export function failedStub(url: string, pageId: string, cls: ErrorClass, httpStatus: number | null): PageCapture {
  const u = new URL(url);
  return {
    url, path: u.pathname + u.search, page_id: pageId, page_type: "unknown", page_type_reason: "capture", classification: null,
    page_group: pageGroupOf("unknown", u.pathname), D: {} as ViewportCapture, M: {} as ViewportCapture, timing: { D: {}, M: {} },
    page_error: { page_url: url, code: "bot_protection", kind: cls, reason: cls, signals: [], http_status: httpStatus, viewports: [] },
  };
}
