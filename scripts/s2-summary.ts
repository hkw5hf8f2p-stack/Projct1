/** Зводить артефакти S2 у таблицю критеріїв виходу 1–9 (числа беруться з файлів, не з пам'яті). SL_WRITE_ARTIFACTS=1 → пише criteria-summary.json у репо. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactDir } from "./artifact-dir.js";

const dir = artifactDir("sprint-2");
const rd = <T = Record<string, any>>(f: string): T | null => (existsSync(path.join(dir, f)) ? (JSON.parse(readFileSync(path.join(dir, f), "utf8")) as T) : null); // eslint-disable-line @typescript-eslint/no-explicit-any
const c = rd("kill9-worker-crawl.json"), l = rd("kill9-worker-lighthouse.json"), a = rd("kill9-api.json"), p = rd("partial-failure.json"), t = rd("taxonomy-48.json");
const r = rd("repeat.json"), d = rd("ttl-and-delete.json"), s = rd("ssrf-via-api.json"), li = rd("listen.json"), sec = rd("secrets-scan.json"), lh = rd("kill9-worker-lighthouse-lh.json");
const kills = [c, l, a];
const lost = kills.reduce((n, k) => n + (k?.integrity.pages_lost ?? 999) + (k?.integrity.evidence_lost ?? 0), 0);
const dup = kills.reduce((n, k) => n + (k?.integrity.pages_duplicated ?? 999) + (k?.integrity.evidence_duplicated ?? 0) + (k?.integrity.jobs_duplicated ?? 0), 0);
const orph = [c, l].reduce((n, k) => n + (k ? k.orphans_after.tracked_pids_still_alive.length + k.orphans_after.descendants_of_dead_worker_still_alive.length + k.orphans_after.independent_scan.orphan_browsers.length + k.orphans_after.independent_scan.orphan_postgres.length : 999), 0) + (a ? a.orphans_after.orphan_browsers.length + a.orphans_after.orphan_postgres.length : 999);
const out = {
  "1_restart_kill9": { scenarios_passed: `${kills.filter((k) => k?.pass).length}/3`, pages_lost_plus_evidence_lost: lost, duplicated: dup, lighthouse_rows_exactly_once: lh?.ok ?? null },
  "2_partial_failure": { status: p?.status, audits_failed_due_to_one_page_or_lighthouse: p?.audits_failed_because_of_one_page_or_lighthouse, warnings: p?.warnings?.length, pass: p?.pass },
  "3_taxonomy_48": { classes_passed: `${t?.classes_passed}/${t?.classes_total}`, zero_analysis_on_failure: t?.rows.every((x: { evidence_rows: number }) => x.evidence_rows === 0) },
  "4_repeat": { independent_audit_runs: r?.distinct_audit_runs, first_unchanged: r?.first_unchanged },
  "5_ttl_delete": { percent_removed: d?.percent_removed, fresh_untouched: d ? d.ttl.fresh_files_after === d.ttl.fresh_files_before : null, pass: d?.pass },
  "6_ssrf_via_api": { entry: `${s?.summary.entry_rejected}/${s?.summary.entry_vectors}`, canary_hits_entry: s?.summary.entry_canary_hits, canary_hits_worker_fixture_mode: s?.summary.worker_canary_hits_A, canary_hits_worker_prod_mode: s?.summary.worker_canary_hits_C, control_canary_hits_when_allowed: s?.summary.control_B_canary_hits, pass: s?.pass },
  "7_secrets": { raw_matches: sec?.git_grep.raw_matches, explained: sec?.git_grep.explained_by_allowlist, unexplained: sec?.git_grep.unexplained.length, planted_fake_key_found_by_predicate: sec?.control_planted_fake_key.found_as_unexplained, pass: sec?.pass },
  "8_orphans_after_kill9": { orphans: orph, foreign_browsers_untouched: c?.orphans_after.independent_scan.foreign_browsers_untouched.length },
  "9_listen": { loopback_only: li?.loopback_only, control_host_0000_without_token_exit_code: li?.control_host_0000_no_token.exit_code, control_exposed_with_token_shows_non_loopback: li?.control_host_0000_with_token.shows_non_loopback, pass: li?.pass },
};
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "criteria-summary.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1));
