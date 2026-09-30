/** Фікстурний приклад звіту для UI (S5): shop (S1a) + EXAMPLE_LLM. Детермінований (фіксований generated_at). */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "@sitelens/schemas";
import { buildReport } from "../build.js";
import { loadS1aRun } from "../load.js";
import { EXAMPLE_LLM } from "./example-llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SHOP_RUN_DIR = path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop");
export const SHOP_CLEAN_RUN_DIR = path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop-clean");
export const FIXED_TS = "2026-09-30T00:00:00Z";

export function exampleReport(): Report {
  const art = loadS1aRun(SHOP_RUN_DIR, { language: "uk", id: "aud_example000000000", created_at: FIXED_TS, completed_at: FIXED_TS, snapshot_at: FIXED_TS });
  return buildReport(art, EXAMPLE_LLM, { generated_at: FIXED_TS, provenance: { kind: "example_fixture", note: "S1a shop artifacts + hand-written example LLM data (not model output)" } }).report;
}
