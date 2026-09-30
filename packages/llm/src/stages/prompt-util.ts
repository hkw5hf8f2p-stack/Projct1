import type { PromptDef } from "../../prompts/types.js";
import type { AuditStage, LlmRequest, ContentPart, LogicalKey } from "../types.js";

export const LANG_NAME = { uk: "Ukrainian", en: "English" } as const;

export function fill(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`prompt placeholder {{${k}}} без значення`);
    return vars[k] as string;
  });
  return out;
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
