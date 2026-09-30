import { DATA_RULE, NO_ISSUE_RULE, NO_NUMBERS_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { SnapshotEvalLlm } from "../src/sim-schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

/** SPEC §19A. Вхід — перше вікно + тайли висотою вікна з перекриттям (D4), НЕ full-page скриншот. */
export const snapshotEvaluatorV1: PromptDef = {
  id: "snapshot-evaluator-v1",
  system: [
    "You simulate ONE behavioral lens looking at ONE page of a website while trying to do ONE customer task.",
    "A behavioral lens is a set of behavioral tendencies (how much category knowledge, price sensitivity, trust requirement, decision speed and so on). It is not a demographic persona: never infer or mention age, gender, occupation, family status, income or any other personal characteristic, and never attach population percentages to a lens.",
    "You are given: the lens, the task, the first browser window of the page as an image, then tiles (further slices of the page, each the height of a window, with overlap) and an accessibility outline plus the visible text. You never see a full-page screenshot; you must not make claims about parts of the page that no supplied tile shows. Put such doubts in uncertainties.",
    "Report what the lens notices, what it understands, what is unclear, and which action it would most likely take next.",
    "A friction is a concrete obstacle for THIS task on THIS page. Report a friction only if something supplied supports it.",
    "Every friction needs evidence in exactly one of two forms: (a) a verbatim quote copied from the supplied visible text or accessibility outline, written inside double quotes; or (b) the text NOT_FOUND: followed by what is missing, only when the problem is an absence and none of the supplied tiles show it. Never invent or paraphrase a quote. A friction with evidence the code cannot verify is discarded.",
    "category must be one of the allowed categories. claim_kind must be one of the listed values for that category; use general if none fits. tile_id is the id of the tile that shows the evidence (t0 is the first window).",
    "verdict: no_issue when the page serves this lens and task well (frictions must then be empty); issues_found when at least one friction is supported; cannot_judge when the supplied material is not enough.",
    "success: true when the lens can complete the task from this page state, false when it cannot, partial when it can only partly.",
    "Do not state numbers, counts, percentages, prices you calculated or forecasts of conversion, sales, revenue or customer behavior. Numbers are computed by code. Quotes may contain numbers exactly as on the page.",
    NO_NUMBERS_RULE,
    UNKNOWN_RULE,
    NO_ISSUE_RULE,
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write noticed, understood, unclear, likely_next_action, positive_signals, uncertainties and final_summary in this language. Quotes stay exactly as on the page.",
    "Allowed categories: {{CATEGORIES}}.",
    "Allowed claim_kind values per category (JSON): {{CLAIM_KINDS}}.",
    "Lens (derived data):",
    "{{LENS_DATA}}",
    "Task (derived data):",
    "{{TASK_DATA}}",
    "Tiles supplied as images, in order (id, vertical position in CSS px, height):",
    "{{TILE_LIST}}",
    "Accessibility outline (derived from the page):",
    "{{A11Y_DATA}}",
    "Page content:",
    "{{PAGE_DATA}}",
    "Return the structured evaluation for this lens and task on this page.",
  ].join("\n"),
  fragments: {
    /** повторний вхід для сторінок, де тайли обрізано бюджетом (D4/§51): модель має знати, що бачила не все */
    tiles_truncated: "Some lower tiles of this page were not supplied because of the token budget. Do not claim anything about the parts that are not shown; mention this limit in uncertainties.",
  },
  output_name: "snapshot_evaluation",
  output_description: "Structured snapshot evaluation of one page for one behavioral lens and one task.",
  json_schema: zodToJsonSchema(SnapshotEvalLlm),
};
