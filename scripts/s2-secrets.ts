/**
 * Критерій 7: `git grep` секретів у репо (tracked + untracked-не-ignored) = 0 НЕПОЯСНЕНИХ збігів; предикат перевірено на підкладеному фейковому ключі.
 * Пояснені збіги — лише з явного allowlist (файл + регекс рядка + причина); будь-що поза ним — провал. Плюс: .env не в індексі й ignored;
 * секрет-канарка ACCESS_TOKEN відсутній у логах/артефактах прогонів (data/s2/logs, data/s2/artifacts) — якщо вони існують.
 * Запуск: pnpm s2:secrets  (SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/sprint-2/secrets-scan.json)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactDir, REPO_ROOT } from "./artifact-dir.js";

export const PATTERNS: Array<[string, string]> = [
  ["anthropic_key", "sk-ant-[A-Za-z0-9_-]{20,}"],
  ["openai_key", "sk-(proj-)?[A-Za-z0-9]{32,}"],
  ["aws_access_key", "AKIA[0-9A-Z]{16}"],
  ["github_token", "gh[pousr]_[A-Za-z0-9]{36,}"],
  ["private_key_block", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
  ["jwt", "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\."],
  ["assigned_secret", "(api[_-]?key|secret|token|password)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9_./+=-]{16,}[\"']"],
  ["db_url_with_password", "postgres(ql)?://[^:@/[:space:]]+:[^@[:space:]]+@"],
];

/** Пояснені збіги: файл (regex) + регекс рядка + причина. Усе інше — непояснений збіг. */
export const ALLOW: Array<{ file: RegExp; line: RegExp; why: string }> = [
  { file: /^(\.env\.example|infra\/docker-compose\.yml|packages\/db\/src\/env\.ts|scripts\/s2\/harness\.ts)$/, line: /postgres:\/\/sitelens:sitelens@127\.0\.0\.1/, why: "фіксовані локальні облікові дані embedded-кластера (лише loopback, data/pg проєкту); задокументовано в .env.example" },
  { file: /^packages\/llm\/test\/(adapters|cache)\.test\.ts$/, line: /sk-ant-api03-(SECRETSECRETSECRET1234|ECHOECHOECHO9999)/, why: "фейкові ключі — тест редагування (redaction) ключів у логах/записах" },
  { file: /^packages\/browser\/test\/(lighthouse|secure-browser)\.test\.ts$/, line: /(sk-fake-lh-7f3a9c|fake-lh-pw|sk-ant-FAKE-|FAKEPASS)/, why: "фейкові значення — тест, що env браузера/Lighthouse не містить секретів" },
  { file: /^packages\/browser\/test\/net-proxy-limits\.test\.ts$/, line: /hidden-s66-shop\.example/, why: "ім'я хоста в тесті SITE_DENYLIST (не секрет; збіг за шаблоном `secret = \"…\"`)" },
  { file: /^packages\/pipeline\/test\/config\.test\.ts$/, line: /(super-secret-token-value|hunter2)/, why: "фейкові значення — тест, що describeConfig не виводить токен/пароль" },
  { file: /^planning\/qa\/artifacts\/sprint-2\/.*$/, line: /(s2-listen-control-token-0123456789)/, why: "контрольний токен сценарію listen (фейковий, для одноразового exposed-екземпляра); лише в артефакті-доказі, що його НЕМАЄ в логах — див. logs_scan" },
];

const args = PATTERNS.flatMap(([, p]) => ["-e", p]);
const gitGrep = (): string[] => {
  try {
    return execFileSync("git", ["grep", "-nEI", "--untracked", ...args, "--", "."], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return []; // git grep: 1 = немає збігів
    throw e;
  }
};
const parse = (l: string) => { const m = /^([^:]+):(\d+):(.*)$/.exec(l); return m ? { file: m[1]!, line: Number(m[2]), text: m[3]! } : { file: l, line: 0, text: "" }; };
const classify = (lines: string[]) => {
  const hits = lines.map(parse);
  const explained = hits.filter((h) => ALLOW.some((a) => a.file.test(h.file) && a.line.test(h.text)));
  const unexplained = hits.filter((h) => !explained.includes(h));
  return { total: hits.length, explained: explained.length, unexplained };
};

export function scan() {
  return classify(gitGrep());
}

function main() {
  // контроль: підкладений фейковий ключ у untracked-файлі має бути ЗНАЙДЕНИЙ (предикат уміє знаходити)
  const ctlFile = path.join(REPO_ROOT, "scripts", ".secret-scan-control.tmp.txt");
  const FAKE = "sk-ant-api03-" + "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
  writeFileSync(ctlFile, `API_KEY_FOR_CONTROL=${FAKE}\n`);
  let control: ReturnType<typeof classify>;
  try {
    control = scan();
  } finally {
    rmSync(ctlFile, { force: true });
  }
  const controlFound = control.unexplained.some((h) => h.file === "scripts/.secret-scan-control.tmp.txt");
  const real = scan();
  const tracked = execFileSync("git", ["ls-files", "--", ".env", ".env.local", "*.pem", "*.key"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const ignored = (() => { try { execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: REPO_ROOT }); return true; } catch { return false; } })();
  // логи/артефакти прогонів: канарка токена не повинна там бути
  const logs: Record<string, number> = {};
  for (const canary of ["s2-listen-control-token-0123456789"]) {
    let n = 0;
    for (const dir of ["data/s2/logs", "data/s2/artifacts", "data/logs"]) {
      const d = path.join(REPO_ROOT, dir);
      if (!existsSync(d)) continue;
      try { n += execFileSync("grep", ["-rIl", "--", canary, d], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { /* 1 = немає */ }
    }
    logs[canary] = n;
  }
  const out = {
    patterns: PATTERNS.map(([n]) => n), git_grep: { raw_matches: real.total, explained_by_allowlist: real.explained, unexplained: real.unexplained, allowlist: ALLOW.map((a) => ({ file: a.file.source, why: a.why })) },
    control_planted_fake_key: { found_as_unexplained: controlFound, control_unexplained_count: control.unexplained.length, note: "предикат показав підкладений ключ і його прибрано; далі — реальний прогін без нього" },
    env_not_tracked: tracked === "", env_ignored: ignored, logs_scan_canary_token_files: logs,
    pass: real.unexplained.length === 0 && controlFound && tracked === "" && ignored && Object.values(logs).every((n) => n === 0),
  };
  mkdirSync(artifactDir("sprint-2"), { recursive: true });
  writeFileSync(path.join(artifactDir("sprint-2"), "secrets-scan.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ raw: real.total, explained: real.explained, unexplained: real.unexplained.length, control_found: controlFound, pass: out.pass }));
  process.exit(out.pass ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
