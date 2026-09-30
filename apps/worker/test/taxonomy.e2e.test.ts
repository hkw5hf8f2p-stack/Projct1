/**
 * §48 наскрізно через справжній Chromium і egress-проксі: КОЖЕН із 12 класів має маршрут фікстури, правильний клас, людське повідомлення,
 * і при збої 0 аналізу (capturePageFlow повертає ok:false — жодного PageCapture, тож жодних доказів). Контроль: нормальна сторінка проходить.
 * Запуск лише від не-root (Chromium-пісочниця): bash scripts/run-as-sitelens.sh pnpm test
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cmdlineOf, descendantsOf, readStat } from "@sitelens/db";
import { ERROR_CLASSES, humanMessage, loadConfig, type ErrorClass } from "@sitelens/pipeline";
import { startErrorsFixture, type ErrorsFixture } from "../../../fixtures/errors/server.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { capturePageFlow, pageIdOf } from "../src/capture.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let fx: ErrorsFixture;
let rt: Runtime;
let guard: { stop(): number[] };
const runDir = mkdtempSync(path.join(os.tmpdir(), "sl-tax-"));
const seen = new Map<ErrorClass, { url: string; detail: string }>();

const run = async (url: string) => {
  const out = await capturePageFlow(rt, { url, pageId: pageIdOf(new URL(url)), runDir, seedUrl: url });
  return out;
};
const expectClass = async (url: string, cls: ErrorClass) => {
  const out = await run(url);
  expect(out.ok, `${url} має бути збоєм ${cls}`).toBe(false);
  if (out.ok) return;
  expect(out.failure.errorClass).toBe(cls);
  seen.set(cls, { url, detail: out.failure.detail });
  expect(humanMessage(cls, "uk").length).toBeGreaterThan(30);
};
const browserProcs = () =>
  descendantsOf(process.pid).filter((p) => /chrom|headless/i.test(readStat(p)?.comm ?? "")).map((pid) => ({ pid, cmd: cmdlineOf(pid) }));
const killWhenBrowserBusy = async (pick: (p: { pid: number; cmd: string }) => boolean, afterMs = 3500) => {
  await new Promise((r) => setTimeout(r, afterMs));
  const t = browserProcs().filter(pick);
  expect(t.length, "процес для вбивства знайдено").toBeGreaterThan(0);
  for (const p of t) process.kill(p.pid, "SIGKILL");
  return t.length;
};

beforeAll(async () => {
  guard = guardTestProcesses();
  fx = await startErrorsFixture();
  const cfg = loadConfig({ PID_DIR: path.join(runDir, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: `${fx.origin},${fx.httpsOrigin}`, CAPTURE_ATTEMPTS: "1" } as NodeJS.ProcessEnv);
  rt = createRuntime(cfg, null as never, null as never);
});
afterAll(async () => {
  await rt?.close();
  await fx?.close();
  guard?.stop();
  rmSync(runDir, { recursive: true, force: true });
});

describe("§48: 12 класів через справжній браузер", () => {
  it("контроль: нормальна сторінка захоплюється (предикат уміє й пропускати)", async () => {
    const out = await run(fx.origin + "/ok");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.capture.D.completeness.visible_text_length).toBeGreaterThan(200);
      expect(readFileSync(path.join(runDir, "pages", "ok", "1440x1000", "capture.json"), "utf8").length).toBeGreaterThan(1000);
    }
  });

  it("invalid_url: адресу поза allowlist блокує egress-проксі (worker-шар SSRF), не 403", () => expectClass("http://127.0.0.2:4198/x", "invalid_url"));
  it("invalid_url: небезпечний порт (Chromium відмовляє до проксі)", () => expectClass("http://127.0.0.1:6000/x", "invalid_url"));
  it("dns_failure: .invalid-домен", () => expectClass("http://sl-no-such-host.invalid/", "dns_failure"));
  it("ssl_failure: самопідписаний HTTPS", () => expectClass(fx.httpsOrigin + "/ok", "ssl_failure"));
  it("bot_protection: імітація Cloudflare-challenge (403 + cf-mitigated)", () => expectClass(fx.origin + "/e/cf", "bot_protection"));
  it("captcha: сторінка з reCAPTCHA", () => expectClass(fx.origin + "/e/captcha", "captcha"));
  it("redirect_loop: 302 ↔ 302", () => expectClass(fx.origin + "/e/redirect-loop", "redirect_loop"));
  it("unsupported_site: HTTP 500 / 404 / application/pdf", async () => {
    await expectClass(fx.origin + "/e/500", "unsupported_site");
    await expectClass(fx.origin + "/e/404", "unsupported_site");
    await expectClass(fx.origin + "/e/pdf", "unsupported_site");
  });
  it("empty_page: 200 з порожнім body", () => expectClass(fx.origin + "/e/empty", "empty_page"));
  it("js_rendering_failure: порожній #app + виняток у скрипті", () => expectClass(fx.origin + "/e/js-broken", "js_rendering_failure"));

  it("browser_crash: браузер вбито (SIGKILL) посеред навігації", async () => {
    const p = run(fx.origin + "/e/timeout");
    await killWhenBrowserBusy((x) => !x.cmd.includes("--type=") && /headless_shell|chrom/.test(x.cmd));
    const out = await p;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.errorClass).toBe("browser_crash");
      seen.set("browser_crash", { url: fx.origin + "/e/timeout (SIGKILL browser)", detail: out.failure.detail });
    }
    // після краху наступне захоплення працює: браузер перезапущено (рантайм відновлюється)
    const again = await run(fx.origin + "/ok-b");
    expect(again.ok).toBe(true);
  }, 90_000);

  it("page_crash: рендерер вкладки вбито (SIGKILL) посеред навігації", async () => {
    const p = run(fx.origin + "/e/timeout");
    const n = await killWhenBrowserBusy((x) => x.cmd.includes("--type=renderer"));
    expect(n).toBeGreaterThan(0);
    const out = await p;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.errorClass).toBe("page_crash");
      seen.set("page_crash", { url: fx.origin + "/e/timeout (SIGKILL renderer)", detail: out.failure.detail });
    }
    expect((await run(fx.origin + "/ok-c")).ok).toBe(true);
  }, 90_000);

  it("timeout: сервер не відповідає (навігація 30 с)", () => expectClass(fx.origin + "/e/timeout", "timeout"), 120_000);

  it("усі 12 класів покрито, кожен показаний хоча б раз (12/12)", () => {
    const missing = ERROR_CLASSES.filter((c) => !seen.has(c));
    expect(missing).toEqual([]);
    expect(seen.size).toBe(12);
  });
});
