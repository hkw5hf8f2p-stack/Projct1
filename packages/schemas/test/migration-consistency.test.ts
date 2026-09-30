/** Міграція 001 ↔ Zod: колонки й CHECK-списки не розходяться; заборонені поля відсутні (SQL не виконується — S2). */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as S from "../src/index.js";

const MIG = path.resolve(import.meta.dirname, "../../db/migrations");
const SQL = readFileSync(path.join(MIG, "001_init.sql"), "utf8");
/** усі наступні міграції (002+): колонки, додані ALTER TABLE … ADD COLUMN, доповнюють таблицю (DEV-55/DEV-68) */
const LATER = readdirSync(MIG).filter((f) => /^(00[2-9]|0[1-9]\d)_.*\.sql$/.test(f)).sort().map((f) => readFileSync(path.join(MIG, f), "utf8").replace(/--.*$/gm, "")).join("\n");

function tables(sql: string): Map<string, { cols: Map<string, { required: boolean }> }> {
  const out = new Map<string, { cols: Map<string, { required: boolean }> }>();
  const re = /CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/g;
  for (const m of sql.matchAll(re)) {
    const cols = new Map<string, { required: boolean }>();
    for (const line of m[2]!.split("\n")) {
      const c = /^ {2}(\w+)\s+(text\[\]|text|integer|boolean|double precision|timestamptz|jsonb)\b(.*)$/.exec(line);
      if (!c) continue;
      const rest = c[3]!;
      cols.set(c[1]!, { required: /NOT NULL/.test(rest) && !/DEFAULT/.test(rest) });
    }
    out.set(m[1]!, { cols });
  }
  for (const a of LATER.matchAll(/ALTER TABLE (\w+)\s+([\s\S]*?);/g)) {
    const t = out.get(a[1]!);
    if (!t) continue;
    for (const line of a[2]!.split("\n")) {
      const c = /^\s*ADD COLUMN (\w+)\s+(text\[\]|text|integer|bigint|boolean|double precision|timestamptz|jsonb)\b(.*?),?\s*$/.exec(line);
      if (c) t.cols.set(c[1]!, { required: /NOT NULL/.test(c[3]!) && !/DEFAULT/.test(c[3]!) });
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeKeys(s: any): string[] {
  const d = s._def;
  if (d.typeName === "ZodEffects") return shapeKeys(d.schema);
  if (d.typeName === "ZodIntersection") return [...new Set([...shapeKeys(d.left), ...shapeKeys(d.right)])];
  if (s.shape) return Object.keys(s.shape);
  throw new Error("unsupported schema node " + d.typeName);
}

const MAP: Array<{ table: string; schema: z.ZodTypeAny; notColumns?: string[]; sqlOnly?: string[] }> = [
  { table: "audit_runs", schema: S.AuditRun },
  { table: "page_artifacts", schema: S.PageArtifact },
  { table: "customer_tasks", schema: S.Task },
  { table: "site_profiles", schema: S.SiteProfile, notColumns: ["customer_tasks"] },
  { table: "behavioral_lenses", schema: S.BehavioralLens },
  { table: "scenarios", schema: S.Scenario },
  { table: "synthetic_sessions", schema: S.SyntheticSession },
  { table: "llm_calls", schema: S.LlmCall },
  { table: "evidence", schema: S.EvidenceRecord },
  { table: "findings", schema: S.Finding, notColumns: ["evidence_ids", "counter_evidence_ids"], sqlOnly: ["created_at", "audit_run_id"] /* audit_run_id проставляє імпорт (як для Evidence S1a) */ },
  { table: "recommendations", schema: S.Recommendation },
];

describe("001_init.sql ↔ Zod", () => {
  const T = tables(SQL);
  for (const { table, schema, notColumns = [], sqlOnly = [] } of MAP) {
    it(`${table}: кожне поле схеми — колонка; кожна обов'язкова колонка — поле схеми`, () => {
      const t = T.get(table);
      expect(t, `таблиця ${table} у SQL`).toBeDefined();
      const keys = shapeKeys(schema);
      for (const k of keys) if (!notColumns.includes(k)) expect(t!.cols.has(k), `${table}.${k} відсутня в SQL`).toBe(true);
      for (const [c, { required }] of t!.cols) if (required && !sqlOnly.includes(c)) expect(keys, `${table}.${c} NOT NULL без default, але не в схемі`).toContain(c);
    });
  }

  it("002_pipeline: language, токени, error_class, warnings — колонки й поля Zod AuditRun (DEV-55 закрито)", () => {
    const t = tables(SQL).get("audit_runs")!;
    for (const k of ["language", "tokens_input", "tokens_output", "error_class", "warnings", "updated_at"]) {
      expect(t.cols.has(k), `audit_runs.${k} з 002`).toBe(true);
      expect(shapeKeys(S.AuditRun), k).toContain(k);
    }
  });

  it("жодних заборонених колонок (market share, TAM, uplift, conversion, revenue)", () => {
    expect((SQL + LATER).replace(/--.*$/gm, "")).not.toMatch(/market_share|\btam\b|uplift|conversion_rate|revenue|population/i);
    for (const s of [S.BehavioralLens, S.Finding, S.AuditRun]) expect(shapeKeys(s).join()).not.toMatch(/market_share|tam|uplift|revenue/);
  });

  it("Variant/Comparison і калібрування — не в міграції (later, DEV-14/DEV-15)", () => {
    expect(T.has("variants")).toBe(false);
    expect(T.has("comparisons")).toBe(false);
    expect(SQL.replace(/--.*$/gm, "")).not.toMatch(/real_segment|experiment/i);
    expect(S.later.Variant).toBeDefined();
  });

  it("pg-boss не створюється в міграції", () => {
    expect(SQL.replace(/--.*$/gm, "")).not.toMatch(/pgboss|CREATE SCHEMA/i);
  });

  const ENUMS: Record<string, readonly (string | number)[]> = {
    chk_audit_runs_status: S.AUDIT_STATUSES,
    chk_audit_runs_llm_mode: S.LLM_MODES,
    chk_audit_runs_llm_provider: S.LLM_PROVIDERS,
    chk_page_artifacts_page_type: S.PAGE_TYPES,
    chk_page_artifacts_page_type_reason: S.UNKNOWN_REASONS,
    chk_customer_tasks_task_type: S.TASK_TYPES,
    chk_scenarios_level: S.LEVELS,
    chk_llm_calls_stage: S.AUDIT_STAGES,
    chk_llm_calls_provider: S.LLM_PROVIDERS,
    chk_llm_calls_status: S.LLM_CALL_STATUSES,
    chk_sessions_level: S.LEVELS,
    chk_sessions_status: S.SESSION_STATUSES,
    chk_sessions_success: S.SESSION_SUCCESS,
    chk_evidence_type: S.EVIDENCE_TYPES,
    chk_evidence_source_class: S.SOURCE_CLASSES,
    chk_evidence_page_type: S.PAGE_TYPES,
    chk_evidence_page_type_reason: S.UNKNOWN_REASONS,
    chk_evidence_category: S.CATEGORIES,
    chk_evidence_assertion: S.ASSERTIONS,
    chk_evidence_viewport: S.VP_CODES,
    chk_evidence_level: S.LEVELS,
    chk_evidence_tier: S.EVIDENCE_TIERS,
    chk_findings_category: S.CATEGORIES,
    chk_findings_stage: S.FUNNEL_STAGES,
    chk_findings_confidence: S.CONFIDENCES,
    chk_findings_strength: S.EVIDENCE_STRENGTHS,
    chk_finding_evidence_role: ["support", "counter"],
  };
  const sqlList = (raw: string) => raw.split(",").map((x) => x.trim()).map((x) => (x.startsWith("'") ? x.slice(1, -1) : Number(x)));

  it("CHECK-списки дорівнюють enum-ам Zod (за іменем обмеження)", () => {
    const found = new Map<string, (string | number)[]>();
    // 001 + пізніші міграції, що перевизначають обмеження (DROP + ADD CONSTRAINT, напр. 004): чинний список — останній за порядком файлів
    for (const m of SQL.matchAll(/CONSTRAINT (chk_\w+) CHECK \(\w+ IN \(([^)]*)\)\)/g)) found.set(m[1]!, sqlList(m[2]!));
    for (const m of LATER.matchAll(/ADD CONSTRAINT (chk_\w+) CHECK \(\w+ IN \(([^)]*)\)\)/g)) if (found.has(m[1]!)) found.set(m[1]!, sqlList(m[2]!));
    for (const [name, expected] of Object.entries(ENUMS)) {
      expect(found.has(name), `${name} у SQL`).toBe(true);
      expect([...found.get(name)!].sort(), name).toEqual([...expected].sort());
    }
    // усі знайдені CHECK … IN покриті мапою (нового enum без перевірки бути не може)
    for (const n of found.keys()) expect(Object.keys(ENUMS), `${n} без звірки`).toContain(n);
    const fam = /evidence_families <@ ARRAY\[([^\]]*)\]/.exec(SQL)!;
    expect(sqlList(fam[1]!.replace(/::text\[\]/, "")).sort()).toEqual([...S.EVIDENCE_FAMILIES].sort());
  });

  it("finding_key і Finding.id у SQL/TS: findingId детермінований", () => {
    expect(S.findingId("cta|product|below_fold")).toBe(S.findingId("cta|product|below_fold"));
    expect(S.findingId("cta|product|below_fold")).toMatch(/^fnd_[0-9a-f]{12}$/);
  });
});
