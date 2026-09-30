/**
 * e2e /settings/ai (BYO AI) на моку API (Playwright route на /settings/ai*). Реального бекенду й провайдера тут немає:
 * перевіряється лише UI-плумбінг (вибір, збереження, ключ не в DOM/storage/URL, видалення, перевірка ok/помилка, overflow, axe).
 * Артефакти — лише з SL_WRITE_ARTIFACTS=1.
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactDir, writeArtifacts } from "../../../scripts/artifact-dir.ts";
import type { AiSettingsView } from "../src/lib/ai-settings";
import { closeBrowser, newCtx, open, pageErrors, startWeb, stopWeb, type Env } from "./harness";
import { badStrings, overflowX } from "./surface";

const OUT = artifactDir("sprint-5");
const SECRET = "sk-test-SECRET123";
const T = 10 * 60_000;
const ENVS: Env[] = [
  { width: 1440, theme: "light", lang: "uk" }, { width: 1440, theme: "dark", lang: "en" },
  { width: 390, theme: "light", lang: "uk" }, { width: 390, theme: "dark", lang: "en" },
];

interface Mock { state: AiSettingsView; puts: Record<string, unknown>[]; checkResult: Record<string, unknown>; deletes: number; failLoad?: boolean }
async function mockApi(page: Page, init?: Partial<AiSettingsView>): Promise<Mock> {
  const m: Mock = {
    state: { kind: "none", model: "", key_set: false, max_audit_tokens: 200000, updated_at: null, source: "none", ...init },
    puts: [], deletes: 0, checkResult: { ok: true, latency_ms: 412, model_reported: "mock-model-1" },
  };
  await page.route(/\/settings\/ai(\/.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname.endsWith("/check")) return json(m.checkResult);
    if (url.pathname.endsWith("/key") && req.method() === "DELETE") {
      m.deletes++;
      const { key_hint: _h, ...rest } = m.state; void _h; m.state = { ...rest, key_set: false };
      return json(m.state);
    }
    if (req.method() === "PUT") {
      const b = req.postDataJSON() as Record<string, unknown>;
      m.puts.push(b);
      const { api_key, ...rest } = b as { api_key?: string } & Record<string, unknown>;
      m.state = { ...m.state, ...(rest as object), model: (rest["model"] as string | undefined) ?? "", ...(rest["base_url"] ? { base_url: rest["base_url"] as string } : {}), source: "ui", key_set: api_key ? true : m.state.key_set, key_hint: api_key ? `…${api_key.slice(-4)}` : m.state.key_hint, updated_at: "2026-09-30T10:00:00Z" } as AiSettingsView;
      return json(m.state);
    }
    return json(m.state); // API ніколи не віддає ключ
  });
  return m;
}
async function shot(page: Page, name: string) {
  if (!writeArtifacts()) return;
  fs.mkdirSync(path.join(OUT, "screens"), { recursive: true });
  await page.screenshot({ path: path.join(OUT, "screens", name), fullPage: true });
}

beforeAll(async () => { await startWeb(); }, 120_000);
afterAll(async () => { await closeBrowser(); stopWeb(); });

describe("/settings/ai", () => {
  it("посилання в шапці веде на сторінку; вибір кожного провайдера показує потрібні поля", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "en" });
    const page = await ctx.newPage();
    await mockApi(page);
    await page.goto("http://127.0.0.1:" + (process.env["SL_WEB_PORT"] ?? 3100) + "/");
    await page.getByTestId("nav-ai").click();
    await page.getByTestId("ai-settings").waitFor();
    const pick = (k: string) => page.getByTestId(`kind-${k}`).click();

    await pick("anthropic");
    expect(await page.locator("#ai-key").getAttribute("type")).toBe("password");
    expect(await page.locator("#ai-key").getAttribute("autocomplete")).toBe("off");
    expect(await page.locator("#ai-base").count()).toBe(0);
    await pick("openai");
    expect(await page.locator("#ai-key").count()).toBe(1);
    expect(await page.locator("#ai-base").count()).toBe(0);
    await pick("openai_compatible");
    expect(await page.locator("#ai-base").count()).toBe(1);
    await pick("claude_cli");
    expect(await page.locator("#ai-key").count()).toBe(0);
    const cli = await page.getByTestId("kind-claude_cli").innerText();
    expect(cli).toContain("claude auth login");
    expect(cli).toContain("pnpm llm:login");
    expect(await page.locator("#ai-model").getAttribute("placeholder")).toMatch(/^e\.g\./);
    expect(await page.locator("#ai-model").inputValue()).toBe(""); // без «дефолтної» моделі
    await pick("none");
    expect(await page.locator("#ai-model").count()).toBe(0);
    expect(await page.getByTestId("ai-notes").innerText()).toMatch(/billed to your account/);
    await ctx.close();
  }, T);

  it("збереження кожного провайдера: правильне тіло PUT; валідація блокує порожню модель / поганий URL", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "en" });
    const page = await open(ctx, "/settings/ai");
    const m = await mockApi(page);
    await page.reload();
    await page.getByTestId("ai-settings").waitFor();
    // негатив: порожня модель
    await page.getByTestId("kind-anthropic").click();
    await page.getByTestId("ai-save").click();
    await page.locator("#ai-model-e").waitFor();
    expect(m.puts).toHaveLength(0);
    // позитив
    await page.locator("#ai-model").fill("m-a");
    await page.locator("#ai-key").fill(SECRET);
    await page.getByTestId("ai-save").click();
    await page.getByTestId("key-saved").waitFor();
    expect(m.puts[0]).toMatchObject({ kind: "anthropic", model: "m-a", api_key: SECRET });
    // openai_compatible: негатив base URL
    await page.getByTestId("kind-openai_compatible").click();
    await page.locator("#ai-model").fill("llama");
    await page.locator("#ai-base").fill("localhost:11434");
    await page.getByTestId("ai-save").click();
    await page.locator("#ai-base-e").waitFor();
    await page.locator("#ai-base").fill("http://localhost:11434/v1");
    await page.getByTestId("ai-save").click();
    await page.getByTestId("ai-msg").waitFor();
    expect(m.puts.at(-1)).toMatchObject({ kind: "openai_compatible", base_url: "http://localhost:11434/v1", model: "llama" });
    expect(m.puts.at(-1)).not.toHaveProperty("api_key"); // ключ не надсилається, якщо не введено
    await page.getByTestId("kind-claude_cli").click();
    await page.getByTestId("ai-save").click();
    await page.getByText("Settings saved.").waitFor();
    expect(m.puts.at(-1)).toMatchObject({ kind: "claude_cli" });
    expect(m.puts.at(-1)).not.toHaveProperty("api_key");
    await page.getByTestId("kind-none").click();
    await page.getByTestId("ai-save").click();
    await page.getByTestId("ai-status").getByText(/No AI/).waitFor();
    expect(m.puts.at(-1)).toMatchObject({ kind: "none" });
    expect(pageErrors(page)).toEqual([]);
    await ctx.close();
  }, T);

  it("ключ не з'являється в DOM/storage/URL/консолі після збереження; видалення ключа", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "en" });
    const page = await open(ctx, "/settings/ai");
    const logs: string[] = [];
    page.on("console", (c) => logs.push(c.text()));
    const m = await mockApi(page);
    await page.reload();
    await page.getByTestId("kind-openai").click();
    await page.locator("#ai-model").fill("m-o");
    await page.locator("#ai-key").fill(SECRET);
    // контроль детектора: до збереження значення є в полі (не в innerHTML, але в value) — і детектор бачить його в value
    expect(await page.locator("#ai-key").inputValue()).toBe(SECRET);
    await page.getByTestId("ai-save").click();
    await page.getByTestId("key-saved").waitFor();
    expect(await page.locator("html").innerHTML()).not.toContain(SECRET);
    expect(await page.locator("#ai-key").inputValue()).toBe("");
    expect(await page.getByTestId("key-saved").innerText()).toContain("…T123"); // …T123
    const stores = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, document.cookie]));
    expect(stores).not.toContain(SECRET);
    await page.reload();
    await page.getByTestId("key-saved").waitFor();
    expect(await page.locator("html").innerHTML()).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    // видалення
    await page.getByTestId("key-delete").click();
    await page.getByTestId("key-none").waitFor();
    expect(m.deletes).toBe(1);
    expect(await page.getByTestId("key-delete").count()).toBe(0);
    // негатив контролю: детектор ловить ключ, якщо він у DOM
    await page.evaluate((s) => { document.body.insertAdjacentHTML("beforeend", `<i>${s}</i>`); }, SECRET);
    expect(await page.locator("html").innerHTML()).toContain(SECRET);
    await ctx.close();
  }, T);

  it("перевірка підключення: ok, кожен клас помилки → людський текст, невідомий клас → запасний", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/settings/ai");
    const m = await mockApi(page, { kind: "anthropic", model: "m-a", key_set: true, key_hint: "…abcd", source: "ui" });
    await page.reload();
    await page.getByTestId("ai-check").click();
    await page.getByTestId("check-ok").waitFor();
    const ok = await page.getByTestId("check-ok").innerText();
    expect(ok).toContain("412");
    expect(ok).toContain("mock-model-1");
    expect(await page.getByTestId("key-saved").innerText()).toContain("…abcd");
    m.checkResult = { ok: false, error_class: "auth", latency_ms: 90 };
    await page.getByTestId("ai-check").click();
    await page.getByTestId("check-fail").waitFor();
    expect(await page.getByTestId("check-fail").innerText()).toContain("Провайдер відхилив ключ");
    m.checkResult = { ok: false, error_class: "something_new", latency_ms: 1 };
    await page.getByTestId("ai-check").click();
    await page.getByText("невідомої причини").waitFor();
    // після зміни форми перевірка вимкнена, доки не збережено
    await page.locator("#ai-model").fill("other");
    expect(await page.getByTestId("ai-check").isDisabled()).toBe(true);
    expect(await badStrings(page)).toEqual([]);
    await ctx.close();
  }, T);

  it("source=env: показує звідки налаштування, ключ з .env не видаляється з UI", async () => {
    const ctx = await newCtx({ width: 390, theme: "dark", lang: "uk" });
    const page = await open(ctx, "/settings/ai");
    await mockApi(page, { kind: "anthropic", model: "m-e", key_set: true, source: "env" });
    await page.reload();
    await page.getByTestId("ai-settings").waitFor();
    expect(await page.getByTestId("ai-source").getAttribute("data-source")).toBe("env");
    expect(await page.getByTestId("ai-source").innerText()).toContain(".env");
    expect(await page.getByTestId("key-delete").count()).toBe(0);
    expect(await page.getByTestId("key-saved").innerText()).toContain(".env");
    await ctx.close();
  }, T);

  it("стани: завантаження, помилка API (retry)", async () => {
    const ctx = await newCtx({ width: 390, theme: "light", lang: "en" });
    const page = await ctx.newPage();
    let fail = true;
    await page.route(/\/settings\/ai$/, async (r) => {
      if (fail) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { class: "internal", message: "x" } }) });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "none", model: "", key_set: false, max_audit_tokens: 100000, updated_at: null, source: "none" }) });
    });
    await page.goto("http://127.0.0.1:" + (process.env["SL_WEB_PORT"] ?? 3100) + "/settings/ai");
    await page.getByTestId("ai-load-error").waitFor();
    await shot(page, "ai-settings-error-390-light-en.png");
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByTestId("ai-settings").waitFor();
    await ctx.close();
  }, T);

  for (const env of ENVS) {
    it(`overflow=0 і axe 0 critical/serious: ${env.width} ${env.theme} ${env.lang}`, async () => {
      const ctx = await newCtx(env);
      const page = await ctx.newPage();
      await mockApi(page, { kind: "openai_compatible", model: "llama", base_url: "http://localhost:11434/v1", key_set: true, key_hint: "…abcd", source: "ui", updated_at: "2026-09-30T10:00:00Z", last_check: { ok: false, at: "2026-09-30T09:00:00Z", error_class: "timeout" } });
      await page.goto("http://127.0.0.1:" + (process.env["SL_WEB_PORT"] ?? 3100) + "/settings/ai");
      await page.getByTestId("ai-settings").waitFor();
      await page.getByTestId("ai-check").click();
      await page.getByTestId("check-ok").waitFor();
      expect(await overflowX(page)).toBe(0);
      const res = await new AxeBuilder({ page }).analyze();
      const bad = res.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(bad).toEqual([]);
      await shot(page, `ai-settings-${env.width}-${env.theme}-${env.lang}.png`);
      for (const k of ["claude_cli", "none"] as const) {
        await page.getByTestId(`kind-${k}`).click();
        expect(await overflowX(page)).toBe(0);
        const r2 = await new AxeBuilder({ page }).analyze();
        expect(r2.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
      }
      await shot(page, `ai-settings-none-${env.width}-${env.theme}-${env.lang}.png`);
      await ctx.close();
    }, T);
  }

  it("звіт: «Модель: provider/model» на Overview з audit.llm_provider/llm_model", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "en" });
    const page = await open(ctx, "/audit/fx_completed");
    await page.getByTestId("report").waitFor({ timeout: 30_000 });
    const txt = await page.getByTestId("ov-model").innerText();
    expect(txt).toMatch(/Model/);
    expect(txt).toMatch(/\w+\/\S+/);
    await ctx.close();
  }, T);
});
