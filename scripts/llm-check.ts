/**
 * pnpm llm:check — один дешевий структурований виклик (ping зі схемою) через claude-cli (DEV-82): перевіряє автентифікацію, --json-schema,
 * розбір виходу й Zod. Провайдер: LLM_MODEL (необов'язково; порожньо — модель CLI за замовчуванням), CLAUDE_CLI_BIN, CLAUDE_CLI_TIMEOUT_MS.
 * $ не рахується (підписка). Код виходу: 0 ок, 1 збій.
 */
import { z } from "zod";
import { ClaudeCliProvider, ProviderAuthError, zodToJsonSchema, type LlmRequest } from "../packages/llm/src/index.js";

const Ping = z.object({ ok: z.literal(true), echo: z.string().min(1) }).strict();
const req: LlmRequest = {
  stage: "site_profile", prompt_id: "llm-check-ping-v1", system: "You are a connectivity check for a structured-output pipeline. Answer only with the requested JSON.",
  content: [{ type: "text", text: 'Return ok=true and echo="pong".' }],
  output: { name: "ping", description: "connectivity check", json_schema: zodToJsonSchema(Ping) }, sampling: { max_tokens: 100 }, logical_key: { prompt_id: "llm-check-ping-v1", step: 0 },
};
const p = new ClaudeCliProvider({ model: process.env["LLM_MODEL"], timeoutMs: process.env["CLAUDE_CLI_TIMEOUT_MS"] ? Number(process.env["CLAUDE_CLI_TIMEOUT_MS"]) : 120_000 });
try {
  const r = await p.complete(req);
  const v = Ping.safeParse(r.json);
  console.log(`модель: ${r.model}; вхід ${r.input_tokens} / вихід ${r.output_tokens} токенів (${r.tokens_estimated ? "оцінка" : "usage CLI"}); ${Math.round(r.latency_ms)} мс`);
  console.log(v.success ? "✓ структурована відповідь пройшла Zod" : `✗ відповідь не пройшла Zod: ${v.error.issues.map((i) => i.message).join("; ")}`);
  process.exit(v.success ? 0 : 1);
} catch (e) {
  console.error(`✗ ${e instanceof ProviderAuthError ? e.message : `${(e as Error).name}: ${(e as Error).message}`}`);
  process.exit(1);
}
