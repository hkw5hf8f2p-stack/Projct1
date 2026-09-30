import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** файли guard-ів: тут заборонена ASCII-межа слова (літерал RegExp, рядок і шаблон, що будують RegExp) */
const GUARD_FILES = ["packages/llm/src/guards/**/*.ts", "packages/reporting/src/guard.ts", "packages/schemas/src/report-text.ts"];
const MSG = "G0-26: ASCII-межа слова (backslash-b) заборонена в guard: використовуй (?<![\\p{L}\\p{N}])…(?![\\p{L}\\p{N}])";
const NO_ASCII_WORD_BOUNDARY = [
  { selector: "Literal[regex.pattern=/\\\\b/]", message: MSG },
  { selector: "Literal[value=/\\\\b/]", message: MSG },
  { selector: "TemplateElement[value.raw=/\\\\b/]", message: MSG },
];

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "**/.next/**", "apps/web/next-env.d.ts", "planning/**", "fixtures/**", "**/artifacts/**", "packages/**/page-scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
  // G0-26: ASCII-межа слова не бачить кирилицю (пропускає UK-речення) — у guard лише (?<![\\p{L}\\p{N}])…(?![\\p{L}\\p{N}])
  {
    files: GUARD_FILES,
    rules: { "no-restricted-syntax": ["error", ...NO_ASCII_WORD_BOUNDARY] },
  },
);
