/** Читання каталогу прогону S1a (pages.json, evidence.json, coverage.json, axe-groups.json, pages/<id>/<WxH>/capture.json). */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Evidence } from "@sitelens/schemas";
import type { AuditArtifacts, AuditIn, AxeGroupIn, CaptureLite, CoverageRowIn, PageIn, VP } from "./types.js";

const J = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

interface PageRow {
  id: string; url: string; page_type: PageIn["page_type"]; page_type_reason: PageIn["page_type_reason"];
  technical_json: {
    viewports?: Partial<Record<VP, [number, number, number]>>;
    capture?: Partial<Record<VP, { capture_complete: boolean; incomplete_reasons: string[] }>>;
    files?: Partial<Record<VP, { dir: string }>>;
    screenshots?: Partial<Record<VP, { viewport?: { file?: string } }>>;
    axe_version?: string;
  };
}

export function loadS1aRun(dir: string, audit: Partial<AuditIn> & { language: AuditIn["language"] }): AuditArtifacts {
  const rows = J<PageRow[]>(path.join(dir, "pages.json"));
  const pages: PageIn[] = rows.map((r) => {
    const t = r.technical_json;
    const captures: PageIn["captures"] = {};
    const viewport: PageIn["viewport"] = {};
    const screenshot: PageIn["screenshot"] = {};
    for (const vp of ["D", "M"] as const) {
      const v = t.viewports?.[vp];
      if (v) viewport[vp] = { w: v[0], h: v[1] };
      const d = t.files?.[vp]?.dir;
      if (d && existsSync(path.join(dir, d, "capture.json"))) captures[vp] = J<CaptureLite>(path.join(dir, d, "capture.json"));
      const s = t.screenshots?.[vp]?.viewport?.file;
      if (s) screenshot[vp] = s;
    }
    return { id: r.id, url: r.url, path: new URL(r.url).pathname, page_type: r.page_type, page_type_reason: r.page_type_reason, capture: t.capture ?? {}, viewport, captures, screenshot };
  });
  const first = rows[0] ? new URL(rows[0].url) : new URL("http://unknown.invalid/");
  return {
    audit: {
      id: audit.id ?? `aud_${path.basename(dir)}`,
      input_url: audit.input_url ?? first.origin + "/",
      normalized_url: audit.normalized_url ?? first.origin + "/",
      domain: audit.domain ?? first.host,
      language: audit.language,
      status: audit.status ?? "completed",
      created_at: audit.created_at ?? null,
      completed_at: audit.completed_at ?? null,
      snapshot_at: audit.snapshot_at ?? null,
      stage_status: audit.stage_status ?? { crawl: { status: "done", reason: null }, capture: { status: "done", reason: null }, accessibility: { status: "done", reason: null } },
    },
    pages,
    evidence: J<unknown[]>(path.join(dir, "evidence.json")).map((e) => Evidence.parse(e)),
    coverage: existsSync(path.join(dir, "coverage.json")) ? J<CoverageRowIn[]>(path.join(dir, "coverage.json")) : [],
    axe_groups: existsSync(path.join(dir, "axe-groups.json")) ? J<AxeGroupIn[]>(path.join(dir, "axe-groups.json")) : [],
    axe_version: rows[0]?.technical_json.axe_version ?? null,
    lighthouse: null,
  };
}
