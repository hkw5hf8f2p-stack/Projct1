import type { PromptDef } from "../../prompts/types.js";
import type { AuditStage, LlmRequest, ContentPart, LogicalKey } from "../types.js";

export const LANG_NAME = { uk: "Ukrainian", en: "English" } as const;

/** Fail-closed: кожен `{{…}}` у ШАБЛОНІ мусить мати коректне ім'я (A-Z, 0-9, _) і значення в vars; інакше — помилка.
 *  Підстановка одноразова, тож `{{…}}` у значеннях (вміст сайту) не інтерпретується й не перевіряється. */
export function fill(tpl: string, vars: Record<string, string>): string {
  for (const m of tpl.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const k = m[1] as string;
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`prompt placeholder {{${k}}}: некоректне ім'я`);
    if (!(k in vars)) throw new Error(`prompt placeholder {{${k}}} без значення`);
  }
  return tpl.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_m, k: string) => vars[k] as string);
}

/** a11y-outline для промпту: порожній вхід не підставляється мовчки — явний рядок із причиною */
export function a11yOutlineText(outline: string | null | undefined, reason = "no ariaSnapshot in the stage input"): string {
  return outline && outline.trim() ? outline : `(accessibility outline unavailable: ${reason})`;
}

export function buildRequest(o: { stage: AuditStage; prompt: PromptDef; vars: Record<string, string>; images?: ContentPart[]; logical: Omit<LogicalKey, "prompt_id">; max_tokens: number }): LlmRequest {
  return {
    stage: o.stage,
    prompt_id: o.prompt.id,
    system: o.prompt.system,
    content: [{ type: "text", text: fill(o.prompt.user_template, o.vars) }, ...(o.images ?? [])],
    output: { name: o.prompt.output_name, description: o.prompt.output_description, json_schema: o.prompt.json_schema },
    sampling: { max_tokens: o.max_tokens },
    logical_key: { prompt_id: o.prompt.id, ...o.logical },
  };
}
