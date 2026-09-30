/**
 * `pnpm validate` з браузерними аудитами (нейтральні хости site-a.test / site-b.test, DEV-74): PASS на коректному наборі,
 * сліпота (немає «degraded» ніде у знімках і звітах), класи сторінок деградованої копії лишились (зміни — лише 5 з §67),
 * SSRF-захист не порушено: allow-list містить рівно `host:port` нейтральних хостів.
 * Запуск: bash scripts/run-as-sitelens.sh pnpm exec vitest run --configLoader runner scripts/validate/validate.browser.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startShopCleanDegraded } from "../../fixtures/shop-clean-degraded/server.js";
import { launchForFixtures } from "../fixture-harness.js";
import { runValidation, type ValidateResult } from "./core.js";
import { auditSnapshots, NEUTRAL_HOSTS, type SnapshotDirs } from "./snapshots.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sl-validate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
const pagesOf = (d: string) => (JSON.parse(readFileSync(path.join(d, "pages.json"), "utf8")) as Array<{ url: string; page_type: string }>);

let dirs: SnapshotDirs;
let full: ValidateResult;

describe("повний validate на браузерних знімках", () => {
  it("аудити shop, site-a (чиста), site-b (деградована) і validate: 4 перевірки PASS (dev), E3c ⏭️ DEFERRED (код 2/5 < 4/5, DEV-77)", async () => {
    dirs = await auditSnapshots(tmp);
    full = await runValidation({ snapshots: { shop: dirs.shop, clean: dirs.clean, degraded: dirs.degraded } });
    expect(full.checks.map((c) => [c.id, c.status])).toEqual([["E1", "PASS"], ["E2", "PASS"], ["E3a", "PASS"], ["E3c", "DEFERRED"], ["E4", "PASS"]]);
    expect(full.verdict).toBe("PASS");
    expect(full.tokens.used).toBeLessThan(full.tokens.max);
  }, 240_000);

  it("E3c: гірше в 5 з 5; КОДОМ 2 (shipping, CTA), решту 3 дав лише fake-LLM (⏭️ live)", () => {
    const d = full.checks.find((c) => c.id === "E3c")!.data as { worse: number; worse_code: number; worse_llm_only: number; dims: Array<{ id: string; source: string }> };
    expect(d.worse).toBe(5);
    expect(d.worse_code).toBe(2);
    expect(d.worse_llm_only).toBe(3);
    expect(Object.fromEntries(d.dims.map((x) => [x.id, x.source]))).toEqual({ shipping_removed: "code", cta_less_visible: "code", vague_headline: "llm", comparison_help_removed: "llm", trust_hidden: "llm" });
    expect(full.checks.find((c) => c.id === "E3c")!.live_deferred.join(" ")).toMatch(/⏭️ live/);
  });

  it("контроль E3c уміє впасти: база проти самої себе → 0 з 5 → strict-live FAIL (у dev ⏭️ DEFERRED, як і 2/5)", async () => {
    const r = await runValidation({ snapshots: { shop: dirs.shop, clean: dirs.clean, degraded: dirs.clean }, checks: ["E3c"], strict_live: true });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect((r.checks[0]!.data as { worse: number }).worse).toBe(0);
  });

  it("сліпота: слова «degraded» немає ні в знімках (URL, текст, метадані), ні в жодному звіті; хости нейтральні", () => {
    for (const d of [dirs.clean, dirs.degraded]) {
      for (const f of walk(d).filter((x) => /\.(json|jsonl)$/.test(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/degrad/i);
    }
    for (const [label, rep] of Object.entries(full.reports)) expect(JSON.stringify(rep), label).not.toMatch(/degrad/i);
    expect(pagesOf(dirs.clean).every((p) => new URL(p.url).host === `${NEUTRAL_HOSTS[0].host}:${NEUTRAL_HOSTS[0].port}`)).toBe(true);
    expect(pagesOf(dirs.degraded).every((p) => new URL(p.url).host === `${NEUTRAL_HOSTS[1].host}:${NEUTRAL_HOSTS[1].port}`)).toBe(true);
  });

  it("класи сторінок деградованої копії збігаються з базою для спільних сторінок (структурно не «зламана»: змінено лише §67)", () => {
    const base = new Map(pagesOf(dirs.clean).map((p) => [new URL(p.url).pathname, p.page_type]));
    const deg = pagesOf(dirs.degraded);
    expect(deg.length).toBeGreaterThanOrEqual(5);
    for (const p of deg) expect(base.get(new URL(p.url).pathname), p.url).toBe(p.page_type);
    // прибрані сторінки справді зникли
    const paths = deg.map((p) => new URL(p.url).pathname);
    expect(paths).not.toContain("/shipping");
    expect(paths).not.toContain("/about");
  });
});

describe("SSRF: нейтральні хости не розширюють дозволів", () => {
  it("дозволено рівно site-a.test:4213 / site-b.test:4214 → loopback; 127.0.0.1:4213, site-c.test, site-a.test на іншому порту — блок", async () => {
    const sb = await launchForFixtures([], NEUTRAL_HOSTS);
    const srv = await startShopCleanDegraded({ port: NEUTRAL_HOSTS[1].port });
    try {
      const ctx = await sb.newContext();
      const page = await ctx.newPage();
      const ok = await page.goto(`http://site-b.test:${NEUTRAL_HOSTS[1].port}/`, { waitUntil: "load" });
      expect(ok?.status()).toBe(200);
      const hitsBefore = srv.log.length;
      for (const bad of [`http://127.0.0.1:${NEUTRAL_HOSTS[1].port}/`, `http://site-c.test:${NEUTRAL_HOSTS[1].port}/`, `http://site-b.test:${NEUTRAL_HOSTS[1].port + 1}/`, `http://site-a.test:${NEUTRAL_HOSTS[1].port}/`]) {
        // блок проксі для plain-HTTP — це відповідь 403 (X-SiteLens-Egress: blocked) або помилка навігації; ніколи не 200
        const res = await page.goto(bad, { waitUntil: "load", timeout: 8000 }).catch(() => null);
        expect(res === null || res.status() === 403, bad).toBe(true);
      }
      expect(srv.log.length, "жоден із заблокованих запитів не дійшов до сервера").toBe(hitsBefore);
      const denied = sb.proxy.log.filter((d) => d.decision === "deny").map((d) => `${d.host}:${d.port}`);
      expect(denied).toEqual(expect.arrayContaining([`127.0.0.1:${NEUTRAL_HOSTS[1].port}`, `site-c.test:${NEUTRAL_HOSTS[1].port}`]));
      expect(srv.state.non_get).toBe(0);
      await ctx.close();
    } finally {
      await srv.close();
      await sb.close();
    }
  }, 60_000);
});
