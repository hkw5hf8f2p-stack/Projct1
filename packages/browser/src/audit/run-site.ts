/**
 * Оркестрація аудиту одного сайту S1a: crawl → захоплення (D+M) → детектори → доказовий JSON у формі рядків
 * PageArtifact/Evidence (SPEC §8, §23) для S2-міграції. Артефакти — у <runDir>; час (метрики) — окремо в timing.json,
 * тож evidence/findings/pages побайтово стабільні між прогонами (3/3).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSecureBrowser, type SecureBrowser } from "../secure-launch.js";
import { captureViewport } from "./capture-page.js";
import { detectBotProtection } from "./botprotect.js";
import { groupFor, HostGate, robotsPolicyFromResponse, robotsVerdict, type RobotsPolicy } from "./ethics.js";

const groupRulesFor = (p: RobotsPolicy) => groupFor(p.groups);
import { crawl, CRAWL_LIMITS, normalizeCrawlUrl, type CrawlResult } from "./crawl.js";
import { assignAxeScopes, groupAxe, type AxeGroup } from "./axe-groups.js";
import { classifyPageType } from "./classify.js";
import { detectAllWithCoverage, pageGroupOf, type CoverageRow } from "./detectors.js";
import { buildFindings } from "./findings.js";
import { classifyPageTypeV1 } from "./legacy-page-type.js";
import { SHIP_RE } from "./patterns.js";
import type { EvidenceRow, FindingRow, PageCapture, PageError, VP } from "./types.js";

export interface AuditOptions {
  secure: SecureBrowser;
  seedUrl: string;
  runDir: string;
  writeShots: boolean;
  tiles: boolean;
  collectFxMarkers?: boolean;
  /** пауза між навігаціями лише для fixture-режиму (0 за замовчуванням); у prod-режимі потрібен `ethics` (DEV-18) */
  minDelayMs?: number;
  /** етика звернень (DEV-18): чесний UA, HostGate (пауза ≥ 1500 мс, 1 сторінка на хост), robots.txt. Обов'язково в prod-режимі проксі. */
  ethics?: { userAgent: string; gate: HostGate; enforceRobots: boolean };
  limits?: { maxPages: number; maxDepth: number; maxProducts: number };
  /** 'v1' — старий класифікатор (7c5cae8): ЛИШЕ контроль метаморфного набору; за замовчуванням 'v2' (page-type-spec.md) */
  engine?: "v1" | "v2";
  /**
   * Прогрес по сторінці (S2-борг): викликається після захоплення кожної сторінки (D+M) — і успішної, і з `page_error`.
   * Збій колбека НЕ валить аудит (§48). `index` — порядковий номер захоплення (0-based), `total_limit` — стеля crawl.
   */
  onPage?: (p: PageProgress) => void | Promise<void>;
}

export interface PageProgress {
  index: number;
  total_limit: number;
  url: string;
  path: string;
  page_id: string;
  page_type: string;
  page_error: PageError | null;
  capture_complete: boolean;
}

export interface AuditResult {
  evidence: EvidenceRow[];
  findings: FindingRow[];
  coverage: CoverageRow[];
  axe_groups: AxeGroup[];
  pages: Array<Record<string, unknown>>;
  crawl: CrawlResult;
  captures: PageCapture[];
  /** помилки сторінок (§48: бот-захист; robots Disallow) — на цих сторінках 0 доказів */
  errors: PageError[];
  /** помилка сайту: seed недоступний через бот-захист/robots → аналізу немає */
  site_error: PageError | null;
  robots: { url: string; status: number | null; fetch: RobotsPolicy["fetch"] } | null;
}

/** robots.txt тим самим захищеним браузером (egress-проксі), не прямим fetch; враховує паузу/1 сторінку на хост. */
async function fetchRobots(secure: SecureBrowser, origin: string, ua: string, gate: HostGate): Promise<{ policy: RobotsPolicy; status: number | null; url: string }> {
  const url = origin + "/robots.txt";
  return gate.run(url, async () => {
    const ctx = await secure.newContext({ userAgent: ua });
    try {
      const page = await ctx.newPage();
      await gate.wait(url);
      let status: number | null = null;
      let body: string | null = null;
      try {
        const resp = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
        status = resp?.status() ?? null;
        body = resp ? await resp.text().catch(() => null) : null;
      } catch {
        status = null;
      }
      return { policy: robotsPolicyFromResponse(status, body), status, url };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

const pageIdOf = (u: URL): string => {
  const raw = (u.pathname + u.search).replace(/^\/+|\/+$/g, "");
  return raw === "" ? "index" : raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
};

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
  assertSecureBrowser(o.secure, "auditSite");
  await mkdir(o.runDir, { recursive: true });
  if (o.secure.proxy.mode.kind === "prod" && !o.ethics) throw new Error("auditSite: у prod-режимі потрібен `ethics` (чесний UA, пауза ≥ 1500 мс, robots.txt; DEV-18)");
  const gate = o.ethics?.gate ?? new HostGate(o.minDelayMs ?? 0, { fixture: true });
  const throttle = gate;
  const userAgent = o.ethics?.userAgent;
  const engine = o.engine ?? "v2";
  const errors: PageError[] = [];
  let robots: { policy: RobotsPolicy; status: number | null; url: string } | null = null;
  if (o.ethics?.enforceRobots) robots = await fetchRobots(o.secure, new URL(o.seedUrl).origin, o.ethics.userAgent, gate);

  let capturedCount = 0;
  const capturePage = async (url: string): Promise<PageCapture> => {
    const u = new URL(url);
    const pageId = pageIdOf(u);
    const base = { secure: o.secure, url, runDir: o.runDir, pageId, writeShots: o.writeShots, tiles: o.tiles, collectFxMarkers: o.collectFxMarkers, throttle, userAgent };
    const once = async (vp: VP) => {
      try {
        return await captureViewport({ ...base, vp });
      } catch {
        return captureViewport({ ...base, vp }); // одна повторна спроба (watchdog/збій сторінки)
      }
    };
    const d = await once("D");
    const m = await once("M");
    const classification = engine === "v1" ? null : classifyPageType(d.capture, m.capture, { seed_url: o.seedUrl });
    // §48: бот-захист/403/429/503 на будь-якому viewport → помилка сторінки, не аналіз
    const bots = ([d.capture, m.capture] as const).map((c) => ({ vp: c.vp, v: detectBotProtection({ http_status: c.http_status, headers: c.response_headers, title: c.title, visible_text: c.visible_text, markers: c.bot_markers }) }));
    const hit = bots.filter((b) => b.v.blocked);
    let page_error: PageError | null = null;
    if (hit.length > 0) {
      const f = hit[0]!.v;
      page_error = { page_url: url, code: "bot_protection", kind: f.kind!, reason: f.reason!, signals: [...new Set(hit.flatMap((b) => b.v.signals))].sort(), http_status: d.capture.http_status ?? m.capture.http_status, viewports: hit.map((b) => b.vp) };
      errors.push(page_error);
    }
    const type = page_error ? "unknown" : classification ? classification.page_type : classifyPageTypeV1(d.capture);
    const reason = page_error ? "capture" : (classification?.reason ?? null);
    const pathOnly = u.pathname + u.search;
    const captured: PageCapture = { url, path: pathOnly, page_id: pageId, page_type: type, page_type_reason: reason, classification, page_error, page_group: pageGroupOf(type, u.pathname), D: d.capture, M: m.capture, timing: { D: d.timing, M: m.timing } };
    if (o.onPage) {
      try {
        await o.onPage({ index: capturedCount, total_limit: (o.limits ?? CRAWL_LIMITS).maxPages, url, path: pathOnly, page_id: pageId, page_type: type, page_error, capture_complete: d.capture.completeness.capture_complete && m.capture.completeness.capture_complete });
      } catch { /* прогрес не має валити аудит (§48) */ }
    }
    capturedCount++;
    return captured;
  };

  // 1 сторінка одночасно на хост: усе захоплення сторінки (D+M) під HostGate.run; пауза — перед кожною навігацією
  const robotsAllow = robots
    ? (url: string) => {
        const x = new URL(url);
        return robotsVerdict(robots!.policy, x.pathname + x.search);
      }
    : undefined;
  const cr = await crawl({ seedUrl: o.seedUrl, capture: (url) => gate.run(url, () => capturePage(url)), limits: o.limits ?? CRAWL_LIMITS, engine, allow: robotsAllow });
  for (const sk of cr.skipped) if (sk.reason === "robots_disallow") errors.push({ page_url: sk.url, code: "robots_disallow", kind: "robots_disallow", reason: `robots.txt забороняє сторінку (${sk.rule}); не відкрито`, signals: [sk.rule ?? ""], http_status: null, viewports: [] });
  errors.sort((a, b) => a.page_url.localeCompare(b.page_url) || a.code.localeCompare(b.code));
  const seedNorm = normalizeCrawlUrl(o.seedUrl);
  const seedPage = cr.pages.find((p) => p.url === seedNorm);
  const site_error: PageError | null = seedPage?.page_error ?? (cr.pages.length === 0 ? (errors.find((e) => e.code === "robots_disallow" && e.page_url === seedNorm) ?? null) : null);

  // ---- детектори
  let evidence: EvidenceRow[] = [];
  const coverage: CoverageRow[] = [];
  for (const p of cr.pages) {
    if (p.page_error) {
      // §48: бот-захист → 0 доказів (включно з axe); факт лишається в coverage
      for (const d of ["shipping_depth", "cta_below_fold", "price_first_viewport"] as const) coverage.push({ detector_id: d, page: p.path, page_type: p.page_type, status: "withheld", reason: `bot_protection:${p.page_error.kind}` });
      continue;
    }
    const r = detectAllWithCoverage({ url: p.url, path: p.path, page_type: p.page_type, page_type_reason: p.page_type_reason, page_group: p.page_group, D: p.D, M: p.M, classification: p.classification, engine });
    evidence.push(...r.evidence);
    coverage.push(...r.coverage);
  }
  coverage.sort((a, b) => a.detector_id.localeCompare(b.detector_id) || a.page.localeCompare(b.page) || a.status.localeCompare(b.status) || a.reason.localeCompare(b.reason));
  assignAxeScopes(evidence);
  const axeGroups = groupAxe(evidence);
  evidence = enrichDepths(evidence, cr);
  evidence.sort((a, b) => a.detector_id.localeCompare(b.detector_id) || a.page_path.localeCompare(b.page_path) || a.viewport.localeCompare(b.viewport) || (a.selector_or_region.selector ?? "").localeCompare(b.selector_or_region.selector ?? ""));
  const findings = buildFindings(evidence);

  const pages = cr.pages.map((p) => pageArtifactRow(p));
  const timing: Record<string, unknown> = {};
  for (const p of cr.pages) timing[p.page_id] = p.timing;

  const crawlDoc = {
    limits: o.limits ?? CRAWL_LIMITS,
    order: cr.log,
    engine,
    pages: cr.pages.map((p) => ({
      url: p.url,
      page_id: p.page_id,
      page_type: p.page_type,
      page_type_reason: p.page_type_reason,
      classification: p.classification ? { is_home: p.classification.is_home, rule: p.classification.rule, scores: p.classification.scores, features: p.classification.features, per_view: { D: { type: p.classification.per_view.D.type, rule: p.classification.per_view.D.rule, P: p.classification.per_view.D.P, K: p.classification.per_view.D.K, C: p.classification.per_view.D.C }, M: { type: p.classification.per_view.M.type, rule: p.classification.per_view.M.rule, P: p.classification.per_view.M.P, K: p.classification.per_view.M.K, C: p.classification.per_view.M.C } } } : null,
    })),
    skipped: cr.skipped.sort((a, b) => a.url.localeCompare(b.url) || a.reason.localeCompare(b.reason)),
    edges: [...new Set(cr.edges.map((e) => `${e.from} -> ${e.to}`))].sort(),
  };
  await writeFile(path.join(o.runDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "axe-groups.json"), JSON.stringify(axeGroups, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "pages.json"), JSON.stringify(pages, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "crawl.json"), JSON.stringify(crawlDoc, null, 2) + "\n");
  await writeFile(path.join(o.runDir, "errors.json"), JSON.stringify({ site_error, page_errors: errors }, null, 2) + "\n");
  await writeFile(
    path.join(o.runDir, "robots.json"),
    JSON.stringify(robots ? { url: robots.url, status: robots.status, fetch: robots.policy.fetch, rules_for_user_agent: robots.policy.fetch === "ok" ? groupRulesFor(robots.policy) : [], disallowed_skipped: errors.filter((e) => e.code === "robots_disallow").map((e) => ({ url: e.page_url, rule: e.signals[0] })) } : { enforced: false }, null, 2) + "\n",
  );
  // лічильник звернень на хост і пауза — артефакт прогону (DEV-18); час — окремо від evidence, тож 3/3 не ламається
  await writeFile(path.join(o.runDir, "host-hits.json"), JSON.stringify(gate.report(), null, 2) + "\n");
  await writeFile(path.join(o.runDir, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
  return { evidence, findings, coverage, axe_groups: axeGroups, pages, crawl: cr, captures: cr.pages, errors, site_error, robots: robots ? { url: robots.url, status: robots.status, fetch: robots.policy.fetch } : null };
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
    page_type_reason: p.page_type_reason,
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
      page_error: p.page_error ?? null,
      response_headers: { D: d.response_headers, M: m.response_headers },
      metrics_ref: "timing.json",
    },
    created_at: null,
  };
}

export type { VP };
