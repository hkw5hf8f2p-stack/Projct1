/**
 * Оркестрація аудиту одного сайту S1a: crawl → захоплення (D+M) → детектори → доказовий JSON у формі рядків
 * PageArtifact/Evidence (SPEC §8, §23) для S2-міграції. Артефакти — у <runDir>; час (метрики) — окремо в timing.json,
 * тож evidence/findings/pages побайтово стабільні між прогонами (3/3).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { captureViewport } from "./capture-page.js";
import { crawl, CRAWL_LIMITS, type CrawlResult } from "./crawl.js";
import { classifyPageType, detectAll, pageGroupOf } from "./detectors.js";
import { buildFindings } from "./findings.js";
import { SHIP_RE } from "./patterns.js";
import type { EvidenceRow, FindingRow, PageCapture, VP } from "./types.js";

export interface AuditOptions {
  browser: Browser;
  seedUrl: string;
  runDir: string;
  writeShots: boolean;
  tiles: boolean;
  collectFxMarkers?: boolean;
  /** пауза між навігаціями; 1500 на живих сайтах (DEV-18), 0 для локальної фікстури */
  minDelayMs?: number;
  limits?: { maxPages: number; maxDepth: number; maxProducts: number };
  newContext?: (options: BrowserContextOptions) => Promise<BrowserContext>;
}

export interface AuditResult {
  evidence: EvidenceRow[];
  findings: FindingRow[];
  pages: Array<Record<string, unknown>>;
  crawl: CrawlResult;
  captures: PageCapture[];
}

const pageIdOf = (u: URL): string => {
  const raw = (u.pathname + u.search).replace(/^\/+|\/+$/g, "");
  return raw === "" ? "index" : raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
};

function makeThrottle(ms: number) {
  let last = 0;
  return {
    wait: async () => {
      if (ms <= 0) return;
      const d = last + ms - Date.now();
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      last = Date.now();
    },
  };
}

/** BFS по графу захоплених сторінок: відстань у кліках до першої сторінки, що задовольняє `goal` (не сама початкова). */
export function bfsDepth(start: string, edges: Array<{ from: string; to: string }>, goal: (url: string) => boolean): { depth: number; path: string[] } | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const prev = new Map<string, string>([[start, ""]]);
  const q: string[] = [start];
  while (q.length) {
    const cur = q.shift()!;
    for (const nx of [...new Set(adj.get(cur) ?? [])].sort()) {
      if (prev.has(nx)) continue;
      prev.set(nx, cur);
      if (goal(nx)) {
        const p: string[] = [nx];
        for (let c = cur; c; c = prev.get(c) ?? "") p.unshift(c);
        return { depth: p.length - 1, path: p };
      }
      q.push(nx);
    }
  }
  return null;
}

export async function auditSite(o: AuditOptions): Promise<AuditResult> {
  await mkdir(o.runDir, { recursive: true });
  const throttle = makeThrottle(o.minDelayMs ?? 0);

  const capturePage = async (url: string): Promise<PageCapture> => {
    const u = new URL(url);
    const pageId = pageIdOf(u);
    const base = { browser: o.browser, url, runDir: o.runDir, pageId, writeShots: o.writeShots, tiles: o.tiles, collectFxMarkers: o.collectFxMarkers, throttle, newContext: o.newContext };
    const once = async (vp: VP) => {
      try {
        return await captureViewport({ ...base, vp });
      } catch {
        return captureViewport({ ...base, vp }); // одна повторна спроба (watchdog/збій сторінки)
      }
    };
    const d = await once("D");
    const m = await once("M");
    const type = classifyPageType(d.capture);
    const pathOnly = u.pathname + u.search;
    return { url, path: pathOnly, page_id: pageId, page_type: type, page_group: pageGroupOf(type, u.pathname), D: d.capture, M: m.capture, timing: { D: d.timing, M: m.timing } };
  };

  const cr = await crawl({ seedUrl: o.seedUrl, capture: capturePage, limits: o.limits ?? CRAWL_LIMITS });

  // ---- детектори
  let evidence: EvidenceRow[] = [];
  for (const p of cr.pages) evidence.push(...detectAll({ url: p.url, path: p.path, page_type: p.page_type, page_group: p.page_group, D: p.D, M: p.M }));
  evidence = enrichDepths(evidence, cr);
  evidence.sort((a, b) => a.detector_id.localeCompare(b.detector_id) || a.page_path.localeCompare(b.page_path) || a.viewport.localeCompare(b.viewport) || (a.selector_or_region.selector ?? "").localeCompare(b.selector_or_region.selector ?? ""));
  const findings = buildFindings(evidence);

  const pages = cr.pages.map((p) => pageArtifactRow(p));
  const timing: Record<string, unknown> = {};
  for (const p of cr.pages) timing[p.page_id] = p.timing;

  const crawlDoc = {
    limits: o.limits ?? CRAWL_LIMITS,
    order: cr.log,
    pages: cr.pages.map((p) => ({ url: p.url, page_id: p.page_id, page_type: p.page_type })),
    skipped: cr.skipped.sort((a, b) => a.url.localeCompare(b.url) || a.reason.localeCompare(b.reason)),
    edges: [...new Set(cr.edges.map((e) => `${e.from} -> ${e.to}`))].sort(),
  };
  await writeFile(path.join(o.runDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "pages.json"), JSON.stringify(pages, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "crawl.json"), JSON.stringify(crawlDoc, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
  return { evidence, findings, pages, crawl: cr, captures: cr.pages };
}

/** depth_clicks (№2) і price_depth_clicks (№10) — інформативні; в предикат не входять (map §3.2, §3.10). */
function enrichDepths(evidence: EvidenceRow[], cr: CrawlResult): EvidenceRow[] {
  const byUrl = new Map(cr.pages.map((p) => [p.url, p]));
  const shipTarget = (url: string) => {
    const p = byUrl.get(url);
    return !!p && [p.D, p.M].some((c) => c.text_nodes.some((n) => !n.a && SHIP_RE.test(n.t)));
  };
  const priceTarget = (url: string) => {
    const p = byUrl.get(url);
    return !!p && p.D.price_candidates.some((c) => !c.excluded);
  };
  return evidence.map((e) => {
    if (e.detector_id === "shipping_depth") {
      const r = bfsDepth(e.page_url, cr.edges, shipTarget);
      e.measurement = { ...e.measurement, depth_clicks: r?.depth ?? null, shipping_found_via: r ? r.path.map((u) => new URL(u).pathname).join(" → ") : null, crawl_pages: cr.pages.length };
      if (r) e.excerpt = `${e.excerpt ?? ""} | Доставку знайдено: ${e.measurement["shipping_found_via"]}`.slice(0, 300);
    }
    if (e.detector_id === "price_first_viewport") {
      const r = bfsDepth(e.page_url, cr.edges, priceTarget);
      e.measurement = { ...e.measurement, price_depth_clicks: r?.depth ?? null, crawl_pages: cr.pages.length };
    }
    return e;
  });
}

function pageArtifactRow(p: PageCapture): Record<string, unknown> {
  const d = p.D;
  const m = p.M;
  return {
    id: p.page_id,
    audit_run_id: null,
    url: p.url,
    page_type: p.page_type,
    title: d.title,
    http_status: d.http_status,
    desktop_screenshot: d.screenshots.fullpage.file,
    mobile_screenshot: m.screenshots.fullpage.file,
    dom_text: null,
    aria_snapshot: d.aria_snapshot,
    visible_text: d.visible_text,
    metadata_json: {
      meta_description: d.meta_description,
      headings: d.headings,
      images: d.images.map((i) => ({ src: i.current_src, alt: i.alt })),
      buttons: d.buttons,
      form_controls: d.form_controls,
      forms: d.forms,
      mobile: { title: m.title, headings: m.headings, buttons: m.buttons },
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
      metrics_ref: "timing.json",
    },
    created_at: null,
  };
}

export type { VP };
