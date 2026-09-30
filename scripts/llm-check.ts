/**
 * pnpm llm:check — один дешевий структурований виклик (ping зі схемою) через claude-cli (DEV-83): перевіряє автентифікацію, --json-schema,
 * розбір виходу й відповідність схемі ping. Провайдер: LLM_MODEL (необов'язково; порожньо — модель CLI за замовчуванням), CLAUDE_CLI_BIN, CLAUDE_CLI_TIMEOUT_MS.
 * $ не рахується (підписка). Код виходу: 0 ок, 1 збій.
 */
import { ClaudeCliProvider, ProviderAuthError, type LlmRequest } from "../packages/llm/src/index.js";

const PING_SCHEMA = { type: "object", properties: { ok: { type: "boolean", const: true }, echo: { type: "string", minLength: 1 } }, required: ["ok", "echo"], additionalProperties: false } as const;
const pingOk = (j: unknown): boolean => typeof j === "object" && j !== null && (j as { ok?: unknown }).ok === true && typeof (j as { echo?: unknown }).echo === "string" && Object.keys(j).length === 2;
const req: LlmRequest = {
  stage: "site_profile", prompt_id: "llm-check-ping-v1", system: "You are a connectivity check for a structured-output pipeline. Answer only with the requested JSON.",
  content: [{ type: "text", text: 'Return ok=true and echo="pong".' }],
  output: { name: "ping", description: "connectivity check", json_schema: PING_SCHEMA as unknown as Record<string, unknown> }, sampling: { max_tokens: 100 }, logical_key: { prompt_id: "llm-check-ping-v1", step: 0 },
};
const p = new ClaudeCliProvider({ model: process.env["LLM_MODEL"], timeoutMs: process.env["CLAUDE_CLI_TIMEOUT_MS"] ? Number(process.env["CLAUDE_CLI_TIMEOUT_MS"]) : 120_000 });
try {
  const r = await p.complete(req);
  const good = pingOk(r.json);
  console.log(`модель: ${r.model}; вхід ${r.input_tokens} / вихід ${r.output_tokens} токенів (${r.tokens_estimated ? "оцінка" : "usage CLI"}); ${Math.round(r.latency_ms)} мс`);
  console.log(good ? "✓ структурована відповідь відповідає схемі ping" : "✗ відповідь не відповідає схемі ping (структурованого виходу немає або він хибний)");
  process.exit(good ? 0 : 1);
} catch (e) {
  console.error(`✗ ${e instanceof ProviderAuthError ? e.message : `${(e as Error).name}: ${(e as Error).message}`}`);
  process.exit(1);
}
