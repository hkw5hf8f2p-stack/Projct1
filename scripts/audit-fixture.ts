/**
 * pnpm run audit:fixture — прогін crawl + детекторів S1a на фікстурах і зведення PASS/FAIL за критеріями виходу.
 * Запуск (пісочниця Chromium не стартує під root, DEV-25): bash scripts/run-as-sitelens.sh pnpm run audit:fixture
 * Пише в planning/qa/artifacts/sprint-1a/{shop,shop-clean,mutants/M*,controls/*}/ і summary.json.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDefects, checkMutant, detectorIdsOf, loadExpected, evidenceKeyWithRegion } from "../packages/browser/src/audit/compare.js";
import type { EvidenceRow, FindingRow } from "../packages/browser/src/audit/types.js";
import type { Mutant } from "../fixtures/shop/server.js";
import { auditFixture, launchForFixtures, runDenyListTest, runNonGetTest, sha, writeJson } from "./fixture-harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(ROOT, "planning/qa/artifacts/sprint-1a");
const SHOP_PORT = 4210;
const CLEAN_PORT = 4211;
const AUX_PORT = 4212;

const fresh = (d: string) => {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
};

const expected = loadExpected(path.join(ROOT, "fixtures/shop/EXPECTED.json"));
const sb = await launchForFixtures([SHOP_PORT, CLEAN_PORT, AUX_PORT]);
const started = Date.now();
try {
  // ---- 1. shop (основна фікстура)
  const shopDir = path.join(ART, "shop");
  fresh(shopDir);
  const shop = await auditFixture({ sb, site: "shop", port: SHOP_PORT, runDir: shopDir, shots: true, tiles: true, fxMarkers: true, logFile: path.join(shopDir, "server-log.jsonl") });
  const defects = checkDefects(expected, shopDir, shop.result.evidence, shop.result.findings);
  const det = defects.filter((d) => d.status !== "SKIP");
  const found = det.filter((d) => d.status === "PASS").length;
  console.log(`shop: ${shop.result.evidence.length} evidence, ${shop.result.findings.length} findings, ${shop.result.captures.length} pages; детерміновані ${found}/${det.length}`);

  // ---- 2. shop-clean
  const cleanDir = path.join(ART, "shop-clean");
  fresh(cleanDir);
  const clean = await auditFixture({ sb, site: "clean", port: CLEAN_PORT, runDir: cleanDir, shots: true, tiles: true, logFile: path.join(cleanDir, "server-log.jsonl") });
  console.log(`shop-clean: ${clean.result.captures.length} pages, ${clean.result.evidence.length} evidence, ${clean.result.findings.length} findings`);

  // ---- 3. мутанти
  const mutants = [];
  for (const d of expected.defects.filter((x) => x.mutant)) {
    const id = d.mutant!.toUpperCase();
    const dir = path.join(ART, "mutants", id);
    fresh(dir);
    const m = await auditFixture({ sb, site: "shop", mutant: d.mutant as Mutant, port: SHOP_PORT, runDir: dir, shots: false });
    const r = checkMutant(d, shop.result.evidence, m.result.evidence);
    mutants.push(r);
    console.log(`${id}: детектор ${detectorIdsOf(d).join("|")} → ${r.fixed_detector_evidence} доказів; решта ${r.others_mutant}/${r.others_baseline} ${r.others_identical ? "ідентична" : "ЗМІНИЛАСЬ +" + r.diff_added.length + " -" + r.diff_removed.length}; регіонні зсуви ${r.region_diffs} → ${r.status}`);
  }

  // ---- 4. контролі DEV-17/DEV-19 (предикат уміє впасти)
  const controls: Record<string, unknown> = {};
  const post = await auditFixture({ sb, site: "shop", control: "post_on_load", port: SHOP_PORT, runDir: path.join(ART, "controls/post_on_load"), shots: false });
  const stuck = await auditFixture({ sb, site: "shop", control: "banner_stuck", port: SHOP_PORT, runDir: path.join(ART, "controls/banner_stuck"), shots: false });
  const conf = (fs: FindingRow[], prefix: string) => fs.filter((f) => f.finding_key.startsWith(prefix)).map((f) => f.confidence);
  const postAbsence = post.result.evidence.filter((e) => e.assertion === "absence");
  controls["post_on_load"] = {
    blocked_requests_count_min: Math.min(...post.result.captures.flatMap((p) => [p.D.completeness.blocked_requests_count, p.M.completeness.blocked_requests_count])),
    absence_evidence: postAbsence.length,
    absence_self_confirming: postAbsence.filter((e) => e.self_confirming).length,
    shipping_confidence: conf(post.result.findings, "shipping|"),
    pricing_confidence: conf(post.result.findings, "pricing|"),
    baseline_shipping_confidence: conf(shop.result.findings, "shipping|"),
    pass: postAbsence.length > 0 && postAbsence.every((e) => !e.self_confirming && !e.capture_complete) && conf(post.result.findings, "shipping|").every((c) => c === "HYPOTHESIS") && conf(post.result.findings, "pricing|").every((c) => c === "HYPOTHESIS"),
  };
  const stuckCta = stuck.result.evidence.filter((e) => e.detector_id === "cta_below_fold");
  controls["banner_stuck"] = {
    cta_evidence: stuckCta.length,
    cta_self_confirming: stuckCta.filter((e) => e.self_confirming).length,
    cta_confidence: conf(stuck.result.findings, "cta|"),
    banner_states: [...new Set(stuck.result.captures.flatMap((p) => [p.D.completeness.banner_state, p.M.completeness.banner_state]))],
    pass: stuckCta.length > 0 && stuckCta.every((e) => !e.self_confirming && e.incomplete_reasons?.includes("banner_open")) && conf(stuck.result.findings, "cta|").every((c) => c === "HYPOTHESIS"),
  };
  console.log("controls:", JSON.stringify(controls));

  // ---- 5. стабільність 3/3
  const runs = [shop.result];
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sl-stab-"));
  for (let i = 2; i <= 3; i++) runs.push((await auditFixture({ sb, site: "shop", port: SHOP_PORT, runDir: path.join(scratch, `run${i}`), shots: false })).result);
  const sig = (r: typeof shop.result) => JSON.stringify(r.evidence.map(evidenceKeyWithRegion));
  const bytes = (r: typeof shop.result) => sha(JSON.stringify(r.evidence) + JSON.stringify(r.findings));
  const stability = { runs: 3, identical_id_selector_region: runs.every((r) => sig(r) === sig(runs[0]!)), identical_bytes_sha256: runs.map(bytes), identical_bytes: new Set(runs.map(bytes)).size === 1, evidence_per_run: runs.map((r) => r.evidence.length) };
  rmSync(scratch, { recursive: true, force: true });
  console.log("stability:", JSON.stringify(stability));

  // ---- 6. не-GET і deny-list
  const nonGet = await runNonGetTest(sb, AUX_PORT);
  const deny = await runDenyListTest(sb, AUX_PORT, path.join(ART, "deny-list-crawl"));
  rmSync(path.join(ART, "deny-list-crawl"), { recursive: true, force: true });
  console.log("non-get:", JSON.stringify(nonGet), "\ndeny-list:", JSON.stringify(deny));

  // ---- 7. артефакти повністю на місці?
  const artifactOk = shop.result.evidence.every((e) => existsSync(path.join(shopDir, e.artifact_reference)) && existsSync(path.join(shopDir, e.screenshot_reference)));

  const passAll =
    det.length === 7 && found === 7 && artifactOk &&
    clean.result.evidence.length === 0 && clean.result.findings.length === 0 &&
    mutants.length === 7 && mutants.every((m) => m.status === "PASS") &&
    stability.identical_id_selector_region && stability.identical_bytes &&
    nonGet.pass && deny.pass &&
    Object.values(controls).every((c) => (c as { pass: boolean }).pass);

  const summary = {
    schema: "sitelens-audit-summary/v1",
    scoring_version: "scoring-v1",
    fixture_expected: "fixtures/shop/EXPECTED.json",
    deterministic_defects: { found: found, of: det.length, results: defects },
    llm_defects: defects.filter((d) => d.status === "SKIP").map((d) => ({ id: d.id, status: "deferred to live pass (без LLM), опорні детектори не входять у 7" })),
    clean: { pages: clean.result.captures.length, evidence: clean.result.evidence.length, findings: clean.result.findings.length, page_types: clean.result.captures.map((p) => [p.path, p.page_type]) },
    mutants: { silent_and_others_unchanged: mutants.filter((m) => m.status === "PASS").length, of: mutants.length, results: mutants },
    stability,
    non_get: nonGet,
    deny_list: deny,
    controls,
    crawl: {
      shop_pages: shop.result.captures.length,
      shop_order: shop.result.crawl.log.map((l) => `${l.depth}:${l.class}:${new URL(l.url).pathname}`),
      deny_list_skipped: shop.result.crawl.skipped.filter((s) => s.reason === "deny_list").length,
      fixture_server_state_after_crawl: shop.server.state,
    },
    artifacts_open: artifactOk,
    overall: passAll ? "PASS" : "FAIL",
  };
  writeJson(path.join(ART, "summary.json"), summary);
  console.log(`\nSUMMARY: детерміновані ${found}/${det.length}, clean ${clean.result.evidence.length} знахідок, мутанти ${summary.mutants.silent_and_others_unchanged}/${mutants.length}, стабільність ${stability.identical_bytes ? 3 : 0}/3, не-GET ${nonGet.pass ? "PASS" : "FAIL"}, deny ${deny.pass ? "PASS" : "FAIL"} → ${summary.overall} (${Math.round((Date.now() - started) / 1000)} с)`);
  for (const d of defects) console.log(`  №${d.id} ${d.status} ${d.detector ?? ""} доказів=${d.evidence_count}${d.failures.length ? " ✗ " + d.failures.join("; ") : ""}`);
  if (!passAll) process.exitCode = 1;
} finally {
  await sb.close();
}
export type { EvidenceRow };
