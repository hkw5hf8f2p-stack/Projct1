/** G0-5 (слухання лише loopback без токена), fixture-режим і тестові гачки заборонені в production, валідація URL на вході. */
import { describe, expect, it } from "vitest";
import { ListenRefused, loadConfig, resolveListen } from "../src/config.js";
import { validateSubmittedUrl } from "../src/url.js";

const cfg = (env: Record<string, string>) => loadConfig({ ...env } as NodeJS.ProcessEnv);

describe("resolveListen (G0-5)", () => {
  it("за замовчуванням 127.0.0.1", () => expect(resolveListen(cfg({}))).toMatchObject({ host: "127.0.0.1", exposed: false }));
  for (const h of ["127.0.0.1", "127.0.0.5", "::1", "localhost"]) it(`loopback ${h} — без токена дозволено`, () => expect(resolveListen(cfg({ HOST: h })).exposed).toBe(false));
  for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com"]) {
    it(`HOST=${h} без токена → ВІДМОВА`, () => expect(() => resolveListen(cfg({ HOST: h }))).toThrow(ListenRefused));
    it(`HOST=${h} з коротким токеном → відмова`, () => expect(() => resolveListen(cfg({ HOST: h, ACCESS_TOKEN: "short" }))).toThrow(/≥ 16/));
    it(`HOST=${h} з токеном ≥ 16 → дозволено (exposed)`, () => expect(resolveListen(cfg({ HOST: h, ACCESS_TOKEN: "0123456789abcdef-token" })).exposed).toBe(true));
  }
  it("порожній ACCESS_TOKEN = не задано", () => expect(() => resolveListen(cfg({ HOST: "0.0.0.0", ACCESS_TOKEN: "" }))).toThrow(ListenRefused));
});

describe("loadConfig", () => {
  it("типові значення з .env.example", () => {
    const c = cfg({});
    expect(c).toMatchObject({ maxPages: 12, maxDepth: 3, artifactTtlDays: 30, port: 3001, host: "127.0.0.1", accessToken: null, fixtureMode: false });
  });
  it("fixture-режим і тестові гачки заборонені при NODE_ENV=production", () => {
    expect(() => cfg({ NODE_ENV: "production", SITELENS_FIXTURE_MODE: "1" })).toThrow(/production/);
    expect(() => cfg({ NODE_ENV: "production", SITELENS_TEST_RESOLVER_MAP: '{"a.test":"1.2.3.4"}' })).toThrow(/production/);
    expect(cfg({ NODE_ENV: "production", SITELENS_FAULTS: "lighthouse_broken" }).faults).toEqual([]);
    expect(cfg({ SITELENS_FAULTS: "lighthouse_broken,page_crash:/x" }).faults).toEqual(["lighthouse_broken", "page_crash:/x"]);
  });
  it("некоректні числа відхиляються", () => {
    expect(() => cfg({ MAX_PAGES: "0" })).toThrow();
    expect(() => cfg({ MAX_PAGES: "abc" })).toThrow();
    expect(() => cfg({ LIGHTHOUSE_FORM_FACTORS: "tablet" })).toThrow();
  });
  it("describeConfig не містить токена", async () => {
    const { describeConfig } = await import("../src/config.js");
    const c = cfg({ ACCESS_TOKEN: "super-secret-token-value", DATABASE_URL: "postgres://u:hunter2@h/db" });
    const s = JSON.stringify(describeConfig(c));
    expect(s).not.toContain("super-secret-token-value");
    expect(s).not.toContain("hunter2");
  });
});

describe("validateSubmittedUrl (вхід API)", () => {
  const plain = { fixtureMode: false, fixtureOrigins: [] as string[] };
  const good = ["https://example.com", "http://example.com/path?q=1#frag", "https://sub.shop.co.uk:8443/", "https://xn--e1afmkfd.xn--p1ai/", "  https://example.com  "];
  for (const u of good) it(`приймає ${JSON.stringify(u)}`, () => expect(validateSubmittedUrl(u, plain).ok).toBe(true));
  it("прибирає #fragment і не змінює хост", () => {
    const r = validateSubmittedUrl("https://Example.com/a#x", plain);
    expect(r).toMatchObject({ ok: true, url: "https://example.com/a", domain: "example.com" });
  });
  const bad = [
    "", "   ", "example.com", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "gopher://x/",
    "http://127.0.0.1/", "http://127.0.0.1:4199/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://localhost/", "http://LOCALHOST./",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/", "http://user:pass@example.com/", "http://public.com@127.0.0.1/", "http://intranet/", "http://foo.internal/", "http://a.local/", "http://[fe80::1]/", "http://[fc00::1]/",
  ];
  for (const u of bad) it(`відхиляє ${JSON.stringify(u)}`, () => expect(validateSubmittedUrl(u, plain).ok).toBe(false));
  it("занадто довгий URL / керівні символи / не рядок", () => {
    expect(validateSubmittedUrl("https://example.com/" + "a".repeat(3000), plain).ok).toBe(false);
    expect(validateSubmittedUrl("https://example.com/\u0000", plain).ok).toBe(false);
    expect(validateSubmittedUrl(42, plain).ok).toBe(false);
  });
  it("fixture-режим: дозволено ЛИШЕ точні origin-и allowlist; решта loopback — відмова (контроль)", () => {
    const fx = { fixtureMode: true, fixtureOrigins: ["http://127.0.0.1:4210"] };
    expect(validateSubmittedUrl("http://127.0.0.1:4210/x", fx)).toMatchObject({ ok: true, fixture: true });
    expect(validateSubmittedUrl("http://127.0.0.1:4211/x", fx).ok).toBe(false);
    expect(validateSubmittedUrl("http://127.0.0.2:4210/x", fx).ok).toBe(false);
    expect(validateSubmittedUrl("http://127.0.0.1:4210/x", plain).ok).toBe(false); // без fixture-режиму — відмова
    expect(validateSubmittedUrl("http://u:p@127.0.0.1:4210/x", fx).ok).toBe(false);
  });
});
