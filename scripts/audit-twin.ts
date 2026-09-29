/**
 * Прогін розкритого двійника (G0-15) через auditSite БЕЗ змін детекторів. Запуск:
 *   bash scripts/run-as-sitelens.sh pnpm exec tsx scripts/audit-twin.ts
 * Пише в planning/qa/artifacts/sprint-1a/twin/ (evidence/findings/pages/crawl, twin-summary.json). twin-report.md генерується окремо з summary.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditSite } from "../packages/browser/src/audit/run-site.js";
import type { EvidenceRow, FindingRow } from "../packages/browser/src/audit/types.js";
import { launchForFixtures, writeJson } from "./fixture-harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TWIN = path.join(ROOT, "planning/sealed/twin");
const OUT = path.join(ROOT, "planning/qa/artifacts/sprint-1a/twin");

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

/** Рукопідготовлена мапа дефект № → detector_id (з завдання), сторінки/viewport з EXPECTED двійника. */
interface Map1 { n: number; label: string; ids: string[]; pages: string[]; vps: Array<"D" | "M"> }
const MAP: Map1[] = [
  { n: 2, label: "shipping_depth", ids: ["shipping_depth"], pages: ["umovy.html", "index.html", "kataloh.html", "tovar-ramka-435.html", "tovar-ramka-435r.html"], vps: ["D", "M"] },
  { n: 5, label: "cta_below_fold", ids: ["cta_below_fold"], pages: ["tovar-ramka-435.html", "tovar-ramka-435r.html"], vps: ["D", "M"] },
  { n: 6, label: "axe:button-name|link-name|label", ids: ["axe:button-name", "axe:link-name", "axe:label"], pages: ["*"], vps: ["M"] },
  { n: 7, label: "horizontal_overflow", ids: ["horizontal_overflow"], pages: ["kataloh.html", "tovar-ramka-435.html", "tovar-ramka-435r.html"], vps: ["M"] },
  { n: 8, label: "oversized_image", ids: ["oversized_image"], pages: ["index.html"], vps: ["D", "M"] },
  { n: 9, label: "axe:image-alt", ids: ["axe:image-alt"], pages: ["kataloh.html", "index.html", "pro-nas.html"], vps: ["D", "M"] },
  { n: 10, label: "price_first_viewport", ids: ["price_first_viewport"], pages: ["tovar-ramka-435.html", "tovar-ramka-435r.html", "kataloh.html", "kosh.html"], vps: ["D", "M"] },
];

const hashOfTwin = (): string => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else files.push(path.relative(TWIN, p)); } };
  walk(TWIN);
  files.sort((a, b) => (Buffer.from("./" + a) < Buffer.from("./" + b) ? -1 : 1));
  const lines = files.map((f) => `${createHash("sha256").update(readFileSync(path.join(TWIN, f))).digest("hex")}  ./${f}\n`).join("");
  return createHash("sha256").update(lines).digest("hex");
};

const requests: Array<{ method: string; path: string }> = [];
const server = http.createServer((req, res) => {
  requests.push({ method: req.method ?? "", path: req.url ?? "" });
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(TWIN, path.normalize(p));
  if (!file.startsWith(TWIN + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const b = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" }).end(req.method === "HEAD" ? undefined : b);
  } catch { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;

const hashBefore = hashOfTwin();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sb = await launchForFixtures([port]);
try {
  const result = await auditSite({ secure: sb, seedUrl: origin + "/index.html", runDir: OUT, writeShots: true, tiles: false, minDelayMs: 0 });
  const vpName = (v: "D" | "M") => (v === "D" ? "1440x1000" : "390x844");
  const base = (e: EvidenceRow) => e.page_path.replace(/^\//, "").split("?")[0]!;
  const findingOf = (e: EvidenceRow): FindingRow | undefined => result.findings.find((f) => f.evidence_ids.includes(e.id));

  const claimed = new Set<string>();
  const defects = MAP.map((m) => {
    const ev = result.evidence.filter((e) => m.ids.includes(e.detector_id));
    const inScope = ev.filter((e) => m.vps.includes(e.viewport) && (m.pages.includes("*") || m.pages.includes(base(e))));
    inScope.forEach((e) => claimed.add(e.id));
    const rows = inScope.map((e) => ({ id: e.id, detector: e.detector_id, page: e.page_path, viewport: vpName(e.viewport), selector: e.selector_or_region.selector ?? null, class: e.source_class, confidence: findingOf(e)?.confidence ?? null, self_confirming: e.self_confirming, capture_complete: e.capture_complete, assertion: e.assertion, evidence: (e.excerpt ?? e.description).slice(0, 160), artifact: e.artifact_reference }));
    const pagesFound = [...new Set(rows.map((r) => r.page))];
    const vpsFound = [...new Set(rows.map((r) => r.viewport))];
    const wantVps = m.vps.map(vpName);
    return {
      n: m.n, detector: m.label, found: rows.length > 0,
      complete_vp_coverage: wantVps.every((v) => vpsFound.includes(v)),
      pages_found: pagesFound, viewports_found: vpsFound, viewports_expected: wantVps,
      evidence_count: rows.length, sample: rows.slice(0, 3),
      out_of_scope_same_detector: ev.length - inScope.length,
      all_rows_compact: rows.map((r) => `${r.page}@${r.viewport}${r.selector ? " " + r.selector : ""} [${r.confidence}]`),
    };
  });
  const detectorsUsed = new Set(MAP.flatMap((m) => m.ids));
  const falsePos = result.evidence.filter((e) => !claimed.has(e.id)).map((e) => ({ id: e.id, detector: e.detector_id, page: e.page_path, viewport: vpName(e.viewport), selector: e.selector_or_region.selector ?? null, in_mapped_detector: detectorsUsed.has(e.detector_id), confidence: findingOf(e)?.confidence ?? null, excerpt: (e.excerpt ?? e.description).slice(0, 140) }));
  const hashAfter = hashOfTwin();
  const nonGet = requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").length;
  const summary = {
    schema: "sitelens-twin-summary/v1",
    twin_hash_before: hashBefore, twin_hash_after: hashAfter, twin_hash_expected: readFileSync(path.join(ROOT, "planning/sealed/twin.sha256"), "utf8").trim().split(/\s+/)[0],
    origin, pages_crawled: result.captures.map((p) => p.path), evidence_total: result.evidence.length, findings_total: result.findings.length,
    non_get_requests: nonGet, requests_total: requests.length,
    deterministic_found: defects.filter((d) => d.found).length, of: MAP.length,
    deterministic_found_full_vp: defects.filter((d) => d.found && d.complete_vp_coverage).length,
    defects, false_positives: falsePos, false_positive_count: falsePos.length,
    evidence_by_detector: Object.fromEntries([...new Set(result.evidence.map((e) => e.detector_id))].sort().map((d) => [d, result.evidence.filter((e) => e.detector_id === d).length])),
  };
  writeJson(path.join(OUT, "twin-summary.json"), summary);
  console.log(`twin: ${summary.pages_crawled.length} pages, ${summary.evidence_total} evidence; детерміновані ${summary.deterministic_found}/7 (повний viewport ${summary.deterministic_found_full_vp}); хибні ${falsePos.length}; non-GET ${nonGet}; hash ${hashBefore === hashAfter ? "незмінний" : "ЗМІНЕНО"}`);
  for (const d of defects) console.log(`  №${d.n} ${d.found ? "FOUND" : "MISS"} ${d.detector} n=${d.evidence_count} vp=${d.viewports_found.join(",")} pages=${d.pages_found.join(",")}`);
} finally {
  await sb.close();
  server.close();
}
