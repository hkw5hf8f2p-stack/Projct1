/**
 * Транспорт `claude-cli` (DEV-83) на ФЕЙКОВОМУ бінарнику `claude` (скрипт-заглушка): справжній `claude` тут НЕ викликається.
 * Форму JSON-виводу (structured_output/result/usage/modelUsage/is_error) зафіксовано одним ручним ping-викликом CLI v2.1.285; тест доводить, що адаптер
 * її розбирає, що прапорці обмежують інструменти (лише Read у tmp), що API-ключі не потрапляють у дочірній процес, і що збої (auth, таймаут, невалідний JSON) обробляються.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeCliProvider, ConfigError, DirStore, LlmClient, OutputInvalidError, ProviderAuthError, ProviderHttpError, ProviderTimeoutError, ReplayCache, TokenBudget, buildCliArgs, claudeCliAuthStatus,
  cliEnv, createClientFromEnv, resolveConfig,
} from "../src/index.js";
import { Tiny, tinyReq } from "./helpers.js";

const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = __dirname;
const mode = () => fs.readFileSync(path.join(dir, "mode.txt"), "utf8").trim();
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.285 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: mode() !== "logged_out", authMethod: "oauth_token", apiProvider: "firstParty" }));
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const addDir = args[args.indexOf("--add-dir") + 1];
  const n = fs.existsSync(path.join(dir, "n.txt")) ? Number(fs.readFileSync(path.join(dir, "n.txt"), "utf8")) + 1 : 1;
  fs.writeFileSync(path.join(dir, "n.txt"), String(n));
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, stdin, cwd: process.cwd(), addDir, files: addDir && fs.existsSync(addDir) ? fs.readdirSync(addDir) : [], env: process.env, pid: process.pid }) + "\\n");
  const m = mode();
  const ok = (extra) => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.5, ...extra }));
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1452, cache_read_input_tokens: 10, output_tokens: 52 };
  if (m === "ok") return ok({ result: '{"answer":"hi"}', structured_output: { answer: "hi" }, usage, modelUsage: { "fake-model-x": {} } });
  if (m === "result_text") return ok({ result: '{"answer":"hi"}', usage, modelUsage: { "fake-model-x": {} } });
  if (m === "no_usage") return ok({ result: "", structured_output: { answer: "hi" } });
  if (m === "bad_then_ok") return n === 1 ? ok({ result: "I think so.", usage }) : ok({ result: "", structured_output: { answer: "fixed" }, usage });
  if (m === "bad_json") return ok({ result: "not json at all", usage });
  if (m === "garbage") { console.log("<html>proxy error</html>"); return; }
  if (m === "auth") { console.error("Not logged in · Please run /login  token=sk-ant-oat01-SECRETSECRET"); console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" })); process.exit(1); }
  if (m === "crash") { console.error("boom"); process.exit(2); }
  if (m === "hang") { setInterval(() => {}, 1000); return; }
});
`;

function fakeBin(mode: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "mode.txt"), mode);
  const setMode = (m: string) => writeFileSync(path.join(dir, "mode.txt"), m);
  const calls = () => (existsSync(path.join(dir, "calls.jsonl")) ? readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string; cwd: string; addDir: string; files: string[]; env: Record<string, string>; pid: number }) : []);
  return { dir, bin, setMode, calls };
}
const base = { PATH: process.env["PATH"], HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-api03-MUSTNOTLEAK", OPENAI_API_KEY: "sk-openai-MUSTNOTLEAK", DATABASE_URL: "postgres://x", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" };

describe("claude-cli: прапорці, ізоляція, розбір виходу (фейковий бінарник)", () => {
  it("структурований вихід: json з structured_output, токени з usage (вхід бюджету = input+cache_creation; cache_read — окремо в provenance), модель з modelUsage, $ не рахується", async () => {
    const f = fakeBin("ok");
    const p = new ClaudeCliProvider({ bin: f.bin, env: base });
    const r = await p.complete(tinyReq());
    expect(r.json).toEqual({ answer: "hi" });
    expect(r).toMatchObject({ provider: "claude-cli", model: "fake-model-x", input_tokens: 2 + 1452, output_tokens: 52, synthetic: false });
    expect(r.provenance).toMatchObject({ cache_read_input_tokens: 10 });
    expect(r.tokens_estimated).toBeUndefined();
    expect(r.provenance).toMatchObject({ provider: "claude-cli", requested_model: "cli-default", actual_model: "fake-model-x", tokens_estimated: false });
    expect(JSON.stringify(r)).not.toMatch(/total_cost|0\.5/);
  });

  it("прапорці: system і схема рівно з запиту; --tools Read і --allowedTools Read; --add-dir = cwd; жодних Bash/Edit/Write/WebFetch/MCP; модель лише з LLM_MODEL", async () => {
    const f = fakeBin("ok");
    const req = tinyReq({ system: "SYSTEM-XYZ" });
    await new ClaudeCliProvider({ bin: f.bin, env: base, model: "my-model" }).complete(req);
    const c = f.calls()[0]!;
    const a = c.args;
    const val = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a[0]).toBe("-p");
    expect(val("--output-format")).toBe("json");
    expect(val("--json-schema")).toBe(JSON.stringify(req.output.json_schema));
    expect(val("--system-prompt")).toBe("SYSTEM-XYZ");
    expect(val("--tools")).toBe("Read");
    expect(val("--allowedTools")).toBe("Read");
    expect(val("--permission-mode")).toBe("dontAsk");
    expect(val("--model")).toBe("my-model");
    expect(a).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(val("--add-dir")).toBe(c.cwd);
    expect(a.join(" ")).not.toMatch(/Bash|Edit|Write|WebFetch|--mcp-config|dangerously|bypassPermissions|--max-turns/);
    expect(c.stdin).toContain("hello"); // user-текст запиту — через stdin, не в argv
    expect(a.join(" ")).not.toContain("hello");
    // без LLM_MODEL прапорця --model немає
    await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(req);
    expect(f.calls()[1]!.args).not.toContain("--model");
  });

  it("зображення: файли в tmp-каталозі (доступ через --add-dir), шляхи в промпті; каталог видаляється після виклику", async () => {
    const f = fakeBin("ok");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const { createHash } = await import("node:crypto");
    const req = tinyReq({ content: [{ type: "text", text: "look" }, { type: "image", media_type: "image/png", sha256: createHash("sha256").update(png).digest("hex"), data_b64: png.toString("base64"), label: "first viewport" }] });
    await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(req);
    const c = f.calls()[0]!;
    expect(c.files).toHaveLength(1);
    expect(c.files[0]).toMatch(/^img1-[0-9a-f]{8}\.png$/);
    expect(c.stdin).toContain(path.join(c.addDir, c.files[0] as string));
    expect(c.stdin).toMatch(/Read tool/);
    expect(existsSync(c.addDir)).toBe(false);
  });

  it("env дочірнього процесу — білий список: ANTHROPIC_API_KEY/OPENAI_API_KEY/DATABASE_URL НЕ передаються (підписка, не API-тариф); PATH, HOME і токен підписки — так", async () => {
    const f = fakeBin("ok");
    await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq());
    const env = f.calls()[0]!.env;
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["PATH"]).toBe(base.PATH);
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-token-value");
    // контроль: cliEnv справді б пропустив ключ, якби той був у білому списку (перевірка вміє впасти)
    expect(cliEnv({ ANTHROPIC_API_KEY: "k", PATH: "p" })).toEqual({ PATH: "p" });
  });

  it("result-текст без structured_output парситься як JSON; без usage — токени estimated з позначкою", async () => {
    const f = fakeBin("result_text");
    expect((await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq())).json).toEqual({ answer: "hi" });
    f.setMode("no_usage");
    const r = await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq());
    expect(r.tokens_estimated).toBe(true);
    expect(r.input_tokens).toBeGreaterThan(0);
    expect(r.provenance).toMatchObject({ tokens_estimated: true });
  });
});

describe("claude-cli: збої", () => {
  it("помилка автентифікації → ProviderAuthError з підказкою `pnpm llm:login`; токен зі stderr НЕ потрапляє в повідомлення", async () => {
    const f = fakeBin("auth");
    const err = await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as Error).message).toMatch(/llm:login/);
    expect((err as Error).message).not.toMatch(/SECRET|sk-ant/);
  });
  it("інший збій (код 2) → ProviderHttpError без вмісту stderr; не-JSON stdout з кодом 0 → json=null (далі repair)", async () => {
    const f = fakeBin("crash");
    const err = await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as Error).message).not.toMatch(/boom/);
    f.setMode("garbage");
    const r = await new ClaudeCliProvider({ bin: f.bin, env: base }).complete(tinyReq());
    expect(r.json).toBeNull();
    expect(r.raw_text).toMatch(/proxy error/);
  });
  it("таймаут → ProviderTimeoutError і дочірній процес убито", async () => {
    const f = fakeBin("hang");
    await expect(new ClaudeCliProvider({ bin: f.bin, env: base, timeoutMs: 400 }).complete(tinyReq())).rejects.toBeInstanceOf(ProviderTimeoutError);
    const pid = f.calls()[0]!.pid;
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("бінарника немає → ConfigError із підказкою", async () => {
    await expect(new ClaudeCliProvider({ bin: "/nonexistent/claude-xyz", env: base }).complete(tinyReq())).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("claude-cli через LlmClient: parse → Zod → repair → кеш E5 із provenance", () => {
  it("невалідна відповідь → один repair-повтор (другий виклик CLI) → валідна в кеш {provider:claude-cli}; replay віддає без CLI", async () => {
    const f = fakeBin("bad_then_ok");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli-cache-"));
    const provider = new ClaudeCliProvider({ bin: f.bin, env: base });
    const client = new LlmClient({ mode: "live", provider, cache: new ReplayCache(new DirStore(dir), "t"), budget: new TokenBudget(1_000_000) });
    const r = await client.call(tinyReq(), Tiny);
    expect(r.value).toEqual({ answer: "fixed" });
    expect(r.calls.map((c) => [c.attempt, c.status])).toEqual([[0, "invalid"], [1, "ok"]]);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[1]!.stdin).toMatch(/invalid_json|issues|Validation/i);
    const entry = new DirStore(dir).get("t", r.calls[1]!.request_hash)!;
    expect(entry).toMatchObject({ provider: "claude-cli", model: "cli-default", synthetic: false });
    expect(entry.provenance).toMatchObject({ provider: "claude-cli", transport: "claude -p (subscription)" });
    // replay: без провайдера. Основна (відхилена) спроба у live-режимі НЕ кешується (G0-16), тож replay того ж запиту = гучний промах — відоме обмеження, DEV-83
    const replay = new LlmClient({ mode: "replay", cache: new ReplayCache(new DirStore(dir, true), "t"), budget: new TokenBudget(1_000_000), cache_identity: { provider: "claude-cli", model: "cli-default" } });
    await expect(replay.call(tinyReq(), Tiny)).rejects.toThrow(/промах кешу/);
    expect(f.calls()).toHaveLength(2); // replay не викликав CLI
  });
  it("невалідно двічі → OutputInvalidError (етап failed), у кеш нічого валідного", async () => {
    const f = fakeBin("bad_json");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli-cache-"));
    const client = new LlmClient({ mode: "live", provider: new ClaudeCliProvider({ bin: f.bin, env: base }), cache: new ReplayCache(new DirStore(dir), "t"), budget: new TokenBudget(1_000_000) });
    await expect(client.call(tinyReq(), Tiny)).rejects.toBeInstanceOf(OutputInvalidError);
    expect(f.calls()).toHaveLength(2);
    expect(existsSync(path.join(dir, "t"))).toBe(false);
  });
});

describe("claude-cli: конфіг і статус автентифікації", () => {
  it("resolveConfig: claude-cli без ключа й без LLM_MODEL дозволено; production заборонено; API-ключі не потрібні", () => {
    expect(resolveConfig({ LLM_PROVIDER: "claude-cli" })).toMatchObject({ provider: "claude-cli", llm_mode: "live", transport: "claude-cli", model: null });
    expect(() => resolveConfig({ LLM_PROVIDER: "claude-cli", NODE_ENV: "production" })).toThrow(/production/);
    expect(resolveConfig({ LLM_PROVIDER: "claude-cli", CLAUDE_CODE_OAUTH_TOKEN: "tok-123" }).secrets).toContain("tok-123");
  });
  it("createClientFromEnv(claude-cli) викликає CLAUDE_CLI_BIN (фейк) і пише в кеш", async () => {
    const f = fakeBin("ok");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli-cache-"));
    const { client } = createClientFromEnv({ LLM_PROVIDER: "claude-cli", CLAUDE_CLI_BIN: f.bin, PATH: process.env["PATH"], LLM_CACHE_NAMESPACE: "n" }, { replayDir: dir });
    const r = await client.call(tinyReq(), Tiny);
    expect(r.value).toEqual({ answer: "hi" });
    expect(new DirStore(dir).get("n", r.calls[0]!.request_hash)?.provenance).toMatchObject({ provider: "claude-cli" });
  });
  it("claudeCliAuthStatus: залогінено / не залогінено / не встановлено", async () => {
    const f = fakeBin("ok");
    expect(await claudeCliAuthStatus({ bin: f.bin, env: base })).toMatchObject({ installed: true, version: "2.1.285 (Claude Code)", logged_in: true, auth_method: "oauth_token" });
    f.setMode("logged_out");
    expect(await claudeCliAuthStatus({ bin: f.bin, env: base })).toMatchObject({ installed: true, logged_in: false });
    expect(await claudeCliAuthStatus({ bin: "/nonexistent/claude-xyz", env: base })).toMatchObject({ installed: false, logged_in: null });
  });
  it("buildCliArgs без моделі не додає --model; порожня/«cli-default» — так само", () => {
    expect(buildCliArgs(tinyReq(), undefined, "/t")).not.toContain("--model");
    expect(buildCliArgs(tinyReq(), "cli-default", "/t")).not.toContain("--model");
  });
});
