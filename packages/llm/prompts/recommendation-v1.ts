import { DATA_RULE, NO_ISSUE_RULE, NO_NUMBERS_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { RecommendationLlm } from "../src/sim-schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

/** SPEC §23: рекомендація існує лише для знахідки з доказом; без знахідки код її відкидає. */
export const recommendationV1: PromptDef = {
  id: "recommendation-v1",
  system: [
    "You receive ONE finding that already has evidence. Write a recommended change and a way to validate it. A recommendation exists only because of this finding; do not recommend anything unrelated to it.",
    "recommended_change: one concrete, minimal change to the page or content that addresses the finding. how_to_validate: a test design (what to compare or observe), not a prediction.",
    "Never predict the effect of the change. Do not write that conversion, sales, revenue or customer behavior will change, and do not give an expected size of any effect. Do not state market size, benchmarks or demographics.",
    "Do not write any digit and no number words (no two, three, half, percent, hundreds, thousands). When you need a count use only these placeholders, which code replaces: {page_count}, {instances}, {priority}, {lens_coverage}, {session_frequency}, {task_coverage}.",
    "verdict: supported when a change clearly follows from the finding; not_supported when it does not (then leave both texts empty). Finding no issue is a valid result; do not manufacture a recommendation.",
    NO_NUMBERS_RULE,
    UNKNOWN_RULE,
    NO_ISSUE_RULE,
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write both fields in this language.",
    "Finding (derived data: category, claim kind, normalized problem text, evidence quotes):",
    "{{FINDING_DATA}}",
    "Placeholders available: {{PLACEHOLDERS}}.",
    "Return the recommendation.",
  ].join("\n"),
  output_name: "recommendation",
  output_description: "Recommended change and validation design for one evidenced finding, without effect predictions.",
  json_schema: zodToJsonSchema(RecommendationLlm),
};
