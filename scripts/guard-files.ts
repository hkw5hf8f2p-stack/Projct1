/**
 * Заморожування guard (G0-15): маніфест SHA-256 файлів guard. `write` — після зеленого lint/typecheck/тестів;
 * `check` — exit 1, якщо файли змінилися після заморожування (прогін запечатаного корпусу тоді недійсний).
 * Використання: tsx scripts/guard-files.ts write|check|hash
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const MANIFEST = path.join(ROOT, "planning/eval/guard-freeze.sha256");

export function guardFiles(): string[] {
  const dir = "packages/llm/src/guards";
  const own = readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts")).sort().map((f) => `${dir}/${f}`);
  return [...own, "packages/schemas/src/report-text.ts", "packages/reporting/src/guard.ts"].filter((f) => existsSync(path.join(ROOT, f)));
}
export function guardManifest(): { files: Record<string, string>; combined: string } {
  const files = Object.fromEntries(guardFiles().map((f) => [f, createHash("sha256").update(readFileSync(path.join(ROOT, f))).digest("hex")]));
  const combined = createHash("sha256").update(Object.entries(files).map(([f, h]) => `${h}  ${f}`).join("\n") + "\n").digest("hex");
  return { files, combined };
}
export const manifestText = (m: ReturnType<typeof guardManifest>): string => `${m.combined}  combined\n` + Object.entries(m.files).map(([f, h]) => `${h}  ${f}`).join("\n") + "\n";
/** true — маніфест існує й збігається; null — маніфесту немає */
export function freezeMatches(): boolean | null {
  if (!existsSync(MANIFEST)) return null;
  return readFileSync(MANIFEST, "utf8") === manifestText(guardManifest());
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const cmd = process.argv[2];
  if (cmd === "write") { writeFileSync(MANIFEST, manifestText(guardManifest())); console.log(`guard-freeze.sha256 записано (${guardFiles().length} файлів)`); }
  else if (cmd === "check") { const ok = freezeMatches(); console.log(ok === null ? "маніфесту немає" : ok ? "guard заморожено: файли збігаються з маніфестом" : "guard ЗМІНЕНО після заморожування"); process.exit(ok ? 0 : 1); }
  else if (cmd === "hash") console.log(guardManifest().combined);
  else { console.error("usage: guard-files.ts write|check|hash"); process.exit(2); }
}
