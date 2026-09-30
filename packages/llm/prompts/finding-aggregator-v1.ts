import { DATA_RULE, NO_ISSUE_RULE, NO_NUMBERS_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { FindingTextLlm } from "../src/sim-schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

/** SPEC §24: нормалізує сирі скарги однієї групи (finding_key, ставить код) в одне формулювання. Групує КОД, не модель. */
export const findingAggregatorV1: PromptDef = {
  id: "finding-aggregator-v1",
  system: [
    "You receive ONE group of similar observations that code has already grouped (same category, page group and claim kind). Individual complaints are not findings. Write one normalized finding in plain words: a short title, the problem, and why it matters for the customer task.",
    "Use only the supplied observations and quotes. Do not add facts. Observations from synthetic lenses are hypotheses about simulated behavior: phrase them as such (for example a synthetic lens hesitated or could not find), never as facts about real customers.",
    "Do not write any digit and no number words (no two, three, half, most-like fractions, percent, hundreds, thousands). When you need a count, use only these placeholders, which code replaces: {page_count}, {instances}, {priority}, {lens_coverage}, {session_frequency}, {task_coverage}. {lens_coverage}, {session_frequency} and {task_coverage} are already complete phrases such as a count of synthetic lenses; write them as a whole phrase, without adding your own words that repeat the unit.",
    "Never predict effect on conversion, sales, revenue, market or customers. Never state market size, benchmarks or demographics.",
    "verdict: supported when the observations support a real problem for the task; not_supported when they do not (then leave title, problem and why_it_matters as empty strings). Finding no issue is a valid result.",
    NO_NUMBERS_RULE,
    UNKNOWN_RULE,
    NO_ISSUE_RULE,
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write title, problem and why_it_matters in this language.",
    "Group (derived data: category, page group, claim kind, pages, deterministic facts and quoted observations):",
    "{{GROUP_DATA}}",
    "Placeholders available for this group: {{PLACEHOLDERS}}.",
    "Return the normalized finding text.",
  ].join("\n"),
  output_name: "finding_text",
  output_description: "Normalized title, problem and why-it-matters for one finding group, without numbers.",
  json_schema: zodToJsonSchema(FindingTextLlm),
};
