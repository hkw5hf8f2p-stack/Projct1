/**
 * Оновлює packages/llm/prompts.lock.json: додає НОВІ id, ніколи не перезаписує існуючий id з іншим хешем
 * (зміна тексту без нової версії — заборонена, SPEC §52). Для зміни промпту створи …-v2 і запусти скрипт.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROMPTS, promptHash } from "../packages/llm/prompts/index.js";
import type { LockFile } from "../packages/llm/prompts/index.js";

const file = path.resolve("packages/llm/prompts.lock.json");
const lock: LockFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { note: "sha256 від {id, system, user_template, output_name, json_schema}. Не редагувати вручну: змінений текст → нова версія промпту.", prompts: {} };
let bad = 0;
for (const p of PROMPTS) {
  const h = promptHash(p);
  const have = lock.prompts[p.id];
  if (!have) { lock.prompts[p.id] = h; console.log(`+ ${p.id} ${h.slice(0, 12)}`); }
  else if (have !== h) { console.error(`✗ ${p.id}: текст змінено без нової версії (lock ${have.slice(0, 12)} ≠ ${h.slice(0, 12)})`); bad++; }
}
if (bad) process.exit(1);
writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
