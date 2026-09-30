/**
 * pnpm llm:login — обгортка для LLM_PROVIDER=claude-cli (DEV-82): перевіряє, що `claude` встановлено, і показує статус автентифікації
 * (`claude auth status --json`). Не залогінено → підказка `claude auth login` (підписка) або `claude setup-token` (довгоживучий токен підписки).
 * `pnpm llm:login -- --run` — додатково запускає `claude auth login` інтерактивно. Токени не читаються й не друкуються.
 */
import { spawn } from "node:child_process";
import { claudeCliAuthStatus } from "../packages/llm/src/index.js";

const bin = process.env["CLAUDE_CLI_BIN"] ?? "claude";
const st = await claudeCliAuthStatus();
if (!st.installed) {
  console.error(`✗ Claude Code CLI («${bin}») не знайдено в PATH. Встанови його за документацією Claude Code (або задай CLAUDE_CLI_BIN) і повтори.`);
  process.exit(1);
}
console.log(`Claude Code CLI: ${st.version ?? "версія невідома"}`);
if (st.logged_in === true) {
  console.log(`Автентифікація: залогінено (метод: ${st.auth_method ?? "?"}, провайдер: ${st.api_provider ?? "?"}).`);
  console.log("Далі: `pnpm llm:check` (один дешевий структурований виклик). Використання: LLM_PROVIDER=claude-cli.");
  process.exit(0);
}
console.log(`Автентифікація: ${st.logged_in === false ? "НЕ залогінено" : `невідомо (${st.detail})`}.`);
console.log("  • підписка (інтерактивно):  claude auth login");
console.log("  • довгоживучий токен підписки (для неінтерактивних запусків):  claude setup-token");
console.log("    (де саме тримати токен — див. вивід команди; ніколи не клади його в репо, лог чи артефакт: лише .env або сховище середовища)");
if (process.argv.includes("--run")) {
  await new Promise<void>((resolve) => spawn(bin, ["auth", "login"], { stdio: "inherit" }).on("close", () => resolve()));
  const again = await claudeCliAuthStatus();
  console.log(`Після входу: ${again.logged_in === true ? "залогінено" : "все ще не залогінено"}.`);
  process.exit(again.logged_in === true ? 0 : 1);
}
process.exit(1);
