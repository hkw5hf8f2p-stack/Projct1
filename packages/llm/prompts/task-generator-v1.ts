import { DATA_RULE, NO_ISSUE_RULE, NO_NUMBERS_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { TasksLlm } from "../src/schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

export const taskGeneratorV1: PromptDef = {
  id: "task-generator-v1",
  system: [
    "From a website's SiteProfile generate between 4 and 7 customer tasks that a visitor could realistically try on THIS site.",
    "Tasks must be relevant to the actual site. Examples of task kinds: understand what the company sells; determine whether a product is appropriate; choose between products; find the total expected price; understand delivery; evaluate credibility; add an appropriate product to cart.",
    "Classify every task into exactly one task_type from the allowed list. Mark is_primary_goal=true on the task that corresponds to the profile's primary_conversion_goal (at least one).",
    "recommended_start_page must be one of the supplied page ids. success_conditions and failure_conditions describe observable states on the site.",
    "Default max_actions is 8.",
    NO_NUMBERS_RULE,
    UNKNOWN_RULE,
    NO_ISSUE_RULE,
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write name, goal and conditions in this language.",
    "Allowed task_type values: {{TASK_TYPES}}.",
    "Supplied pages (id, type, url):",
    "{{PAGE_LIST}}",
    "SiteProfile (derived data):",
    "{{PROFILE_DATA}}",
    "Return {tasks:[...]} with 4 to 7 tasks; task_id values t1, t2, ...",
  ].join("\n"),
  output_name: "customer_tasks",
  output_description: "4-7 customer tasks for the site with task_type classification.",
  json_schema: zodToJsonSchema(TasksLlm),
};
