/**
 * Спайк сумісності S1a крок 1: Playwright Chromium + @axe-core/playwright + Lighthouse на порожній локальній сторінці.
 * Lighthouse підключається до того ж Chromium через --remote-debugging-port (без окремого Chrome).
 * Артефакт: planning/qa/artifacts/sprint-1a/spike.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import lighthouse from "lighthouse";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "planning/qa/artifacts/sprint-1a");
mkdirSync(OUT, { recursive: true });

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blank</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Blank</h1></main></body></html>`;
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const result: Record<string, unknown> = { url, started_at: new Date().toISOString() };
const debugPort = 9333;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: [`--remote-debugging-port=${debugPort}`] });
try {
  result.chromium = browser.version();
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  await page.goto(url);
  result.title = await page.title();

  const axe = await new AxeBuilder({ page }).analyze();
  result.axe = { version: axe.testEngine.version, violations: axe.violations.length, passes: axe.passes.length, incomplete: axe.incomplete.length };

  const lh = await lighthouse(url, {
    port: debugPort,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance", "accessibility"],
    formFactor: "desktop",
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttlingMethod: "provided",
  });
  if (!lh) throw new Error("lighthouse returned undefined");
  const lhr = lh.lhr;
  result.lighthouse = {
    version: lhr.lighthouseVersion,
    runtimeError: lhr.runtimeError ?? null,
    finalUrl: lhr.finalDisplayedUrl,
    scores: Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, v.score])),
    metrics: {
      lcp_ms: lhr.audits["largest-contentful-paint"]?.numericValue ?? null,
      cls: lhr.audits["cumulative-layout-shift"]?.numericValue ?? null,
      tbt_ms: lhr.audits["total-blocking-time"]?.numericValue ?? null,
    },
    userAgent: lhr.environment.hostUserAgent,
  };
  result.ok = !lhr.runtimeError && (lhr.categories.performance?.score ?? null) !== null;
} catch (e) {
  result.ok = false;
  result.error = String((e as Error).stack ?? e);
} finally {
  await browser.close();
  server.close();
}
result.finished_at = new Date().toISOString();
writeFileSync(path.join(OUT, "spike.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
