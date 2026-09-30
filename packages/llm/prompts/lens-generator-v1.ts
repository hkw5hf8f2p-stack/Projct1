import { DATA_RULE, NO_ISSUE_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { LensCandidatesLlm } from "../src/schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

export const lensGeneratorV1: PromptDef = {
  id: "lens-generator-v1",
  system: [
    "Generate a deliberately diverse set of behavioral customer lenses for usability and conversion hypothesis testing.",
    "A behavioral lens is not a demographic persona and does not represent a known percentage of the population.",
    "Vary how users make decisions rather than inventing demographic stereotypes.",
    "Important behavioral dimensions include: category knowledge, price sensitivity, need for trust, decision speed, need for detail, visual sensitivity, comparison behavior, risk aversion, convenience, need for social proof.",
    "The set should contain users who may plausibly consider the offering and should expose different kinds of friction.",
    "Do not attach population percentages. Do not mention age, gender, ethnicity, religion, nationality, income class or family status.",
    "Every numeric variable is between 0.0 and 1.0. If a variable cannot be determined, use the string \"unknown\".",
    "The set must include lenses at these behavioral poles: category novice (category_knowledge <= 0.3); expert (>= 0.7); price-sensitive (price_sensitivity >= 0.7); price-insensitive (<= 0.3); fast decider (decision_speed >= 0.7 and detail_preference <= 0.5); research-heavy (decision_speed <= 0.3 and detail_preference >= 0.6); skeptical (trust_requirement >= 0.7 or risk_aversion >= 0.7).",
    UNKNOWN_RULE,
    NO_ISSUE_RULE,
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write description, primary_goal, likely_questions and likely_objections in this language.",
    "SiteProfile (derived data):",
    "{{PROFILE_DATA}}",
    "Generate exactly {{COUNT}} candidate lenses with ids l01, l02, ...",
    "{{EXTRA_POLES}}",
  ].join("\n"),
  output_name: "behavioral_lenses",
  output_description: "Candidate behavioral lenses (numeric behavioral variables, no demographics).",
  json_schema: zodToJsonSchema(LensCandidatesLlm),
};
