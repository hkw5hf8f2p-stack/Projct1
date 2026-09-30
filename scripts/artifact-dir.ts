/**
 * X-1 (critic S1b/S3): тести не пишуть у закомічені артефакти за замовчуванням.
 * `SL_WRITE_ARTIFACTS=1` → `planning/qa/artifacts/<rel>` (свідоме оновлення доказів, потім коміт);
 * інакше → `os.tmpdir()/sitelens-artifacts-<uid>/<rel>` (прогін `pnpm test` лишає `git status planning/` чистим).
 * Суфікс uid: тести запускаються і від root, і від `sitelens` (run-as-sitelens.sh) — спільний /tmp-каталог, створений
 * одним користувачем (0755), давав EACCES іншому (спостерігалось 30.09).
 * Лише для ЗАПИСУ; закомічені вхідні артефакти (напр. sprint-1a-fix/shop) читаються з репо напряму.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const uid = (): string => (typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username);

export function writeArtifacts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SL_WRITE_ARTIFACTS"] === "1";
}

/** Каталог для запису артефакту тесту; `rel` — шлях відносно `planning/qa/artifacts` (напр. "sprint-1b/ssrf"). */
export function artifactDir(rel: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`artifactDir: лише відносний шлях без '..', отримано ${rel}`);
  return writeArtifacts(env) ? path.join(REPO_ROOT, "planning/qa/artifacts", rel) : path.join(os.tmpdir(), `sitelens-artifacts-${uid()}`, rel);
}
