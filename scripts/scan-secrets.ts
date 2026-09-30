/**
 * S8: секрети по ВСЬОМУ git-дереву (tracked + untracked-не-ignored, через s2-secrets) І по всій історії (`git log --all -p`, лише додані рядки).
 * Патерни й allowlist — ті самі, що в s2-secrets (єдине джерело). Історія: рядок = збіг за патерном → шукається пояснення в ALLOW
 * (файл + рядок); файл із diff-заголовка. Плюс: .env/*.pem/*.key ніколи не були в історії; .env у .gitignore.
 * Контроль (предикат уміє знаходити) — у scan-secrets.test.ts на підкладеному ключі в тексті й у diff-потоці.
 * Запуск: pnpm scan:secrets (код 1 при непояснених збігах).
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { REPO_ROOT } from "./artifact-dir.js";
import { ALLOW, PATTERNS, scan as scanTree } from "./s2-secrets.js";

// POSIX-класи git grep -E → JS
const RES = PATTERNS.map(([name, p]) => [name, new RegExp(p.replace(/\[:space:\]/g, "\\s"))] as const);
export const matchPattern = (text: string): string | null => RES.find(([, re]) => re.test(text))?.[0] ?? null;
export const isExplained = (file: string, text: string): boolean => ALLOW.some((a) => a.file.test(file) && a.line.test(text));

export interface HistHit { commit: string; file: string; pattern: string; text: string }
/** Розбір unified-diff потоку: лише додані рядки (не «+++»). */
export function scanDiffLines(lines: Iterable<string>): { added_matches: number; explained: number; unexplained: HistHit[] } {
  let commit = "", file = "";
  let matches = 0, explained = 0;
  const unexplained: HistHit[] = [];
  for (const l of lines) {
    const c = /^commit ([0-9a-f]{40})/.exec(l);
    if (c) { commit = c[1]!.slice(0, 10); continue; }
    const f = /^\+\+\+ b\/(.*)$/.exec(l);
    if (f) { file = f[1]!; continue; }
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    const text = l.slice(1);
    const pat = matchPattern(text);
    if (!pat) continue;
    matches++;
    if (isExplained(file, text)) explained++;
    else unexplained.push({ commit, file, pattern: pat, text: text.trim().slice(0, 100).replace(/[A-Za-z0-9_-]{24,}/g, (m) => m.slice(0, 8) + "…") });
  }
  return { added_matches: matches, explained, unexplained };
}

async function scanHistory() {
  const p = spawn("git", ["log", "--all", "-p", "--no-color", "--no-ext-diff", "-U0", "--format=commit %H"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const rl = createInterface({ input: p.stdout });
  for await (const l of rl) if (l.startsWith("commit ") || l.startsWith("+++ ") || (l.startsWith("+") && matchPattern(l.slice(1)))) lines.push(l);
  await new Promise((r) => p.on("close", r));
  return scanDiffLines(lines);
}

async function main() {
  const tree = scanTree();
  const hist = await scanHistory();
  const commits = Number(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: REPO_ROOT, encoding: "utf8" }).trim());
  const everTracked = execFileSync("git", ["log", "--all", "--name-only", "--format=", "--", ".env", ".env.local", "*.pem", "*.key"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const ignored = (() => { try { execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: REPO_ROOT }); return true; } catch { return false; } })();
  const pass = tree.unexplained.length === 0 && hist.unexplained.length === 0 && everTracked === "" && ignored;
  for (const h of tree.unexplained) console.error(`tree ${h.file}:${h.line}: ${h.text.slice(0, 60)}…`);
  for (const h of hist.unexplained) console.error(`history ${h.commit} ${h.file} [${h.pattern}] ${h.text}`);
  console.log(JSON.stringify({ commits_scanned: commits, tree: { raw: tree.total, explained: tree.explained, unexplained: tree.unexplained.length }, history: { added_matches: hist.added_matches, explained: hist.explained, unexplained: hist.unexplained.length }, env_files_ever_committed: everTracked === "" ? 0 : everTracked.split("\n").length, env_ignored: ignored, pass }));
  process.exit(pass ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) void main();
