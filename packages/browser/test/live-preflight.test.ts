/** audit:live — передпольотна перевірка (DEV-18, G0-13): URL → SITE_DENYLIST → добовий ліміт. Без мережі й браузера. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DailyAuditLimiter } from "../src/audit/ethics.js";
import { liveOutDir, preflightLive } from "../src/audit/live-preflight.js";
import { parseSiteDenylist } from "../src/net/site-denylist.js";

describe("preflightLive", () => {
  const mk = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sl-pre-"));
    return { dir, limiter: new DailyAuditLimiter(path.join(dir, "data/c.json"), 5, () => new Date("2026-09-29T12:00:00Z")) };
  };
  it("дозволений сайт проходить; 6-й аудит за добу — відмова; SITE_DENYLIST (ім'я і хеш) блокує до лічильника; SSRF-літерал і userinfo — відмова", () => {
    const { dir, limiter } = mk();
    try {
      const deny = parseSiteDenylist("secret-site.example");
      for (let i = 1; i <= 5; i++) expect(preflightLive("https://shop.example/", { denylist: deny, limiter })).toMatchObject({ ok: true, host: "shop.example", daily: { count: i } });
      expect(preflightLive("https://shop.example/x", { denylist: deny, limiter })).toMatchObject({ ok: false, step: "daily_limit" });
      const before = limiter.tryRecord("secret-site.example"); // лічильник перед перевіркою denylist: 1
      expect(before.count).toBe(1);
      expect(preflightLive("https://www.secret-site.example/", { denylist: deny, limiter })).toMatchObject({ ok: false, step: "denylist" });
      expect(limiter.tryRecord("secret-site.example").count).toBe(2); // denylist-відмова лічильник не рухала
      expect(preflightLive("https://a.secret-site.example/", { denylist: deny, limiter })).toMatchObject({ ok: false, step: "denylist" });
      expect(preflightLive("http://127.0.0.1:4210/", { denylist: deny, limiter })).toMatchObject({ ok: false, step: "url" });
      expect(preflightLive("https://user:p@shop.example/", { denylist: deny, limiter })).toMatchObject({ ok: false, step: "url" });
      expect(liveOutDir("/r", "shop.example")).toBe("/r/planning/qa/artifacts/sprint-1b/live/shop.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
