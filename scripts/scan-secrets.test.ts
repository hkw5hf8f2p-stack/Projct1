import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PATTERNS } from "./s2-secrets.js";
import { isExplained, matchPattern, scanDiffLines } from "./scan-secrets.js";

const FAKE = "sk-ant-api03-" + "PLANTEDPLANTEDPLANTED1234";
const PG = "postgres://sitelens:sitelens@127.0.0.1:54329/sitelens";
describe("scan-secrets (уміє впасти)", () => {
  it("кожен патерн має позитивний випадок (жодного мертвого)", () => {
    const samples: Record<string, string> = {
      anthropic_key: FAKE, openai_key: "sk-" + "a".repeat(40), aws_access_key: "AKIA" + "A".repeat(16), github_token: "ghp_" + "a".repeat(36),
      private_key_block: "-----BEGIN " + "RSA PRIVATE KEY-----", jwt: "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + ".sig",
      assigned_secret: 'const token = "' + "x".repeat(20) + '"', db_url_with_password: "postgres://u:hunter2@db.example.com/x",
    };
    for (const [name] of PATTERNS) expect(matchPattern(samples[name]!), name).toBe(name);
  });
  it("негативний: звичайний код і токен без значення не збігаються", () => {
    for (const t of ["const x = process.env.ANTHROPIC_API_KEY;", "token: string", "// sk-ant is the prefix", "postgres://127.0.0.1/db"]) expect(matchPattern(t), t).toBeNull();
  });
  it("історія: доданий підкладений ключ у diff — непояснений; видалений («-») і allowlist-рядок — ні", () => {
    const diff = [
      "commit " + "a".repeat(40), "+++ b/src/config.ts", `+const k = "${FAKE}"`,
      "commit " + "b".repeat(40), "+++ b/.env.example", `+DATABASE_URL=${PG}`,
      "commit " + "c".repeat(40), "+++ b/src/old.ts", `-const k = "${FAKE}"`,
    ];
    const r = scanDiffLines(diff);
    expect(r.added_matches).toBe(2);
    expect(r.explained).toBe(1);
    expect(r.unexplained).toHaveLength(1);
    expect(r.unexplained[0]).toMatchObject({ commit: "a".repeat(10), file: "src/config.ts", pattern: "anthropic_key" });
    expect(JSON.stringify(r.unexplained)).not.toContain("PLANTEDPLANTEDPLANTED1234"); // звіт не друкує ключ повністю
    expect(isExplained("src/config.ts", PG)).toBe(false); // allowlist прив'язаний до файлу
  });
  it("історія: справжній git-репо — ключ, доданий і потім видалений, все одно знайдено в `git log -p`", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "sl-scan-secrets-"));
    try {
      const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: d, encoding: "utf8" });
      g("init", "-q");
      writeFileSync(path.join(d, "a.ts"), `export const k = "${FAKE}";\n`);
      g("add", "."); g("commit", "-qm", "add");
      writeFileSync(path.join(d, "a.ts"), "export const k = process.env.K;\n");
      g("commit", "-qam", "remove");
      const log = g("log", "--all", "-p", "--no-color", "-U0", "--format=commit %H");
      expect(scanDiffLines(log.split("\n")).unexplained).toHaveLength(1); // видалення з дерева не стирає з історії
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
