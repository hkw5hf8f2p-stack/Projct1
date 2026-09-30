/**
 * pnpm run audit:live -- <url> [--out-dir <шлях>] — аудит ЖИВОГО публічного сайту (прод-режим, не fixture).
 * Етика (DEV-18): чесний UA, пауза ≥ 1500 мс між навігаціями, 1 сторінка одночасно на хост, ≤ 5 аудитів на сайт за добу
 * (data/audit-counter.json, gitignored), robots.txt через той самий захищений браузер (egress-проксі), лічильник звернень — артефакт.
 * SITE_DENYLIST (env SITELENS_SITE_DENYLIST, G0-13) перевіряється ДО запуску браузера і в egress-проксі. Лише GET; SSRF-фільтр на кожен запит.
 * Запуск (не root, DEV-25): bash scripts/run-as-sitelens.sh pnpm run audit:live -- https://example.com/
 * ЗАБОРОНЕНО запускати на сайтах поза planning/security/live-dev-sites.md (G0-14) без дозволу власника.
 * Вихід за замовчуванням: planning/qa/artifacts/sprint-1b/live/<host>/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DailyAuditLimiter, HONEST_USER_AGENT, HostGate, MAX_AUDITS_PER_DAY, MIN_DELAY_MS } from "../packages/browser/src/audit/ethics.js";
import { liveOutDir, preflightLive } from "../packages/browser/src/audit/live-preflight.js";
import { auditSite } from "../packages/browser/src/audit/run-site.js";
import { loadSiteDenylist } from "../packages/browser/src/net/site-denylist.js";
import { secureLaunch } from "../packages/browser/src/secure-launch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2).filter((a) => a !== "--");
const oi = argv.indexOf("--out-dir");
const outArg = oi >= 0 ? argv[oi + 1] : undefined;
const url = argv.find((a, i) => !a.startsWith("--") && (oi < 0 || i !== oi + 1));
if (!url) {
  console.error("використання: pnpm run audit:live -- <url> [--out-dir <шлях>]");
  process.exit(2);
}

const limiter = new DailyAuditLimiter(path.join(ROOT, "data/audit-counter.json"), MAX_AUDITS_PER_DAY);
const pre = preflightLive(url, { denylist: loadSiteDenylist(), limiter });
if (!pre.ok) {
  console.error(`ВІДМОВА (${pre.step}): ${pre.reason}`);
  process.exit(3);
}
const outDir = path.resolve(ROOT, outArg ?? liveOutDir(ROOT, pre.host));
mkdirSync(outDir, { recursive: true });
console.log(`live: ${pre.url} → ${outDir} (аудит ${pre.daily.count}/${pre.daily.limit} за ${pre.daily.day} UTC; UA ${HONEST_USER_AGENT})`);

const sb = await secureLaunch({ mode: "prod" });
try {
  const gate = new HostGate(MIN_DELAY_MS);
  const started = Date.now();
  const r = await auditSite({ secure: sb, seedUrl: pre.url, runDir: outDir, writeShots: true, tiles: true, ethics: { userAgent: HONEST_USER_AGENT, gate, enforceRobots: true } });
  const report = gate.report();
  const blockedPerPage = r.captures.map((p) => ({ page: p.path, D: p.D.completeness.blocked_requests_count, M: p.M.completeness.blocked_requests_count }));
  const summary = {
    schema: "sitelens-live-summary/v1",
    url: pre.url,
    host: pre.host,
    ethics: { user_agent: HONEST_USER_AGENT, min_delay_ms: MIN_DELAY_MS, daily: pre.daily, robots: r.robots, host_hits: report.per_host, max_concurrent_pages_per_host: report.max_concurrent_pages_per_host },
    pages: r.captures.map((p) => ({ url: p.url, page_type: p.page_type, error: p.page_error?.kind ?? null })),
    errors: r.errors,
    site_error: r.site_error,
    evidence: r.evidence.length,
    findings: r.findings.length,
    blocked_requests_per_page: blockedPerPage,
    proxy_decisions: { total: sb.proxy.log.length, deny: sb.proxy.log.filter((d) => d.decision !== "allow").length },
    seconds: Math.round((Date.now() - started) / 1000),
    note: "precision живих тверджень — не тут: її звіряють sl-qa-tester і sl-critic незалежно зі скриншотами (S1b, real-env pass)",
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(path.join(outDir, "proxy-log.json"), JSON.stringify(sb.proxy.log, null, 2) + "\n");
  console.log(`live: ${r.captures.length} сторінок, ${r.evidence.length} доказів, ${r.findings.length} знахідок, помилок ${r.errors.length}${r.site_error ? ` (САЙТ: ${r.site_error.code}/${r.site_error.kind})` : ""}`);
  if (r.site_error) process.exitCode = 4;
} finally {
  await sb.close();
}
