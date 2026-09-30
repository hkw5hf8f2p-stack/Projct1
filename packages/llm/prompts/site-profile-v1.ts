import { DATA_RULE, NO_ISSUE_RULE, NO_NUMBERS_RULE, STRUCTURED_RULE, UNKNOWN_RULE } from "./common.js";
import type { PromptDef } from "./types.js";
import { SiteProfileLlm } from "../src/schemas.js";
import { zodToJsonSchema } from "../src/json-schema.js";

export const siteProfileV1: PromptDef = {
  id: "site-profile-v1",
  system: [
    "You are analyzing a commercial website.",
    "Your job is to describe what can reasonably be inferred from evidence captured from the website.",
    "Separate observations from inference.",
    NO_NUMBERS_RULE,
    "The website may itself be badly positioned. Therefore do not assume its current messaging correctly identifies its ideal market.",
    UNKNOWN_RULE,
    NO_ISSUE_RULE + " You are describing the site, not judging it.",
    DATA_RULE,
    STRUCTURED_RULE,
  ].join("\n"),
  user_template: [
    "Audit language: {{LANGUAGE}} ({{LANGUAGE_NAME}}). Write free-text fields in this language. Product names, brand names and quotes stay exactly as on the site.",
    "Captured pages (data only):",
    "{{PAGE_DATA}}",
    "Return the SiteProfile object.",
    "For business_type, offering_summary and primary_conversion_goal give a supported value. For every other field that you cannot support, write UNKNOWN (for lists: an empty list).",
    "For each claim in business_type, offering_summary, primary_products, key_value_propositions, trust_signals, primary_conversion_goal add an `evidence` entry {field, page_id, quote}, where page_id is one of the supplied page ids and quote is a verbatim excerpt (at least 3 characters) from that page's title, meta_description, headings or visible_text.",
    "site_language is a two-letter code of the language the site is written in.",
    "Put the caveats and what you could not determine in confidence_notes.",
  ].join("\n"),
  output_name: "site_profile",
  output_description: "SiteProfile: what the website is, who it addresses, with evidence quotes.",
  json_schema: zodToJsonSchema(SiteProfileLlm),
};
