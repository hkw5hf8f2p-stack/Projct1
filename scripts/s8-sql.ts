/** S8 (QA): SQL-докази з БД чистої копії. Використання: tsx scripts/s8-sql.ts */
import pg from "pg";
const c = new pg.Client({ connectionString: process.env["DATABASE_URL"] ?? "postgres://sitelens:sitelens@127.0.0.1:54329/sitelens" });
await c.connect();
const q = async (title: string, sql: string) => { const r = await c.query(sql); console.log(`\n-- ${title}\n${sql.trim()}\n=> ${JSON.stringify(r.rows)}`); };
await q("аудити", `SELECT id, status, llm_mode, error IS NOT NULL AS has_error, stage_status FROM audit_runs ORDER BY created_at`);
await q("знахідок усього", `SELECT count(*)::int AS findings FROM findings`);
await q("ЗНАХІДОК БЕЗ ДОКАЗУ (має бути 0)", `SELECT count(*)::int AS findings_without_evidence FROM findings f WHERE NOT EXISTS (SELECT 1 FROM finding_evidence fe WHERE fe.audit_run_id=f.audit_run_id AND fe.finding_id=f.id AND fe.role='support')`);
await q("докази", `SELECT source_class, count(*)::int FROM evidence GROUP BY 1 ORDER BY 1`);
await q("черга: задачі", `SELECT kind, status, count(*)::int FROM audit_jobs GROUP BY 1,2 ORDER BY 1,2`);
await q("рекомендації без знахідки (має бути 0)", `SELECT count(*)::int AS orphan_recs FROM recommendations r WHERE NOT EXISTS (SELECT 1 FROM findings f WHERE f.audit_run_id=r.audit_run_id AND f.id=r.finding_id)`);
await q("звіт збережено", `SELECT audit_run_id, report_sha256, guard_events, jsonb_array_length(rejected) AS rejected FROM audit_reports`);
// КОНТРОЛЬ, що перевірка вміє впасти: у транзакції вставляємо знахідку БЕЗ доказу -> запит дає 1, COMMIT відхиляється тригером §23
const run = (await c.query(`SELECT id FROM audit_runs ORDER BY created_at LIMIT 1`)).rows[0]?.id;
await c.query("BEGIN");
await c.query(`INSERT INTO findings (audit_run_id,id,finding_key,category,page_group,claim_kind,evidence_families,confidence,evidence_strength,instances) VALUES ($1,'fnd_qacontrol0001','qa|control|x','other','home','x',ARRAY['F-DET'],'HYPOTHESIS',1,1)`, [run]);
await q("КОНТРОЛЬ (у транзакції з підкладеною знахідкою без доказу) -> має бути 1", `SELECT count(*)::int AS findings_without_evidence FROM findings f WHERE NOT EXISTS (SELECT 1 FROM finding_evidence fe WHERE fe.audit_run_id=f.audit_run_id AND fe.finding_id=f.id AND fe.role='support')`);
try { await c.query("COMMIT"); console.log("\n!! КОНТРОЛЬ ПРОВАЛЕНО: COMMIT пройшов"); } catch (e) { console.log(`\n-- COMMIT відхилено тригером §23: ${(e as Error).message}`); await c.query("ROLLBACK").catch(() => null); }
await q("після ROLLBACK: підкладеної знахідки немає", `SELECT count(*)::int AS ctl FROM findings WHERE id='fnd_qacontrol0001'`);
await c.end();
