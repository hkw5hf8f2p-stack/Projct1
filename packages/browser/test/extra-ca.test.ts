/**
 * DEV-90: вузька довіра до одного додаткового CA (`SITELENS_EXTRA_CA_FILE` → `--ignore-certificate-errors-spki-list`).
 * Офлайн-частина: два локальні CA (A — довірений через файл, B — ні), HTTPS-сервери з листами від A і B, «публічна» IP → локальний
 * сервер через ін'єктований дайлер. Контролі: без змінної A теж відхиляється; B відхиляється навіть із прапорцем.
 * Жива частина (лише якщо SITELENS_EXTRA_CA_FILE задано в середовищі тесту): https://www.gov.uk/robots.txt — з прапорцем
 * вантажиться, без нього ERR_CERT_AUTHORITY_INVALID.
 */
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extraCaSpkiHashes, secureChromiumArgs, secureLaunch } from "../src/secure-launch.js";
import type { Dialer, Resolver } from "../src/net/egress-proxy.js";

const FAKE_PUBLIC = "93.184.216.34";
const tmp = mkdtempSync(path.join(os.tmpdir(), "sl-extraca-"));
const sh = (args: string[]) => execFileSync("openssl", args, { cwd: tmp, stdio: "pipe" });

function makeCa(name: string) {
  sh(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=SL Test CA ${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
}
function makeLeaf(ca: string, name: string) {
  sh(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=site.test"]);
  writeFileSync(path.join(tmp, `${name}.ext`), "subjectAltName=DNS:site.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  sh(["x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
}

const servers: https.Server[] = [];
const resolver: Resolver = async () => [{ address: FAKE_PUBLIC, family: 4 }];
const portOf: Record<string, number> = {};
let currentLeaf = "leafA";
const dial: Dialer = (ip, port) => (ip === FAKE_PUBLIC ? net.connect(portOf[currentLeaf]!, "127.0.0.1") : net.connect({ host: ip, port }));

async function serve(leaf: string) {
  const s = https.createServer({ key: readFileSync(path.join(tmp, `${leaf}.key`)), cert: readFileSync(path.join(tmp, `${leaf}.pem`), "utf8") + readFileSync(path.join(tmp, `${leaf === "leafA" ? "caA" : "caB"}.pem`), "utf8") }, (_q, r) => r.end("<title>ok-tls</title><h1>ok</h1>"));
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  servers.push(s);
  portOf[leaf] = (s.address() as AddressInfo).port;
}

beforeAll(async () => {
  makeCa("caA"); makeCa("caB"); makeLeaf("caA", "leafA"); makeLeaf("caB", "leafB");
  await serve("leafA"); await serve("leafB");
});
afterAll(() => { for (const s of servers) s.close(); rmSync(tmp, { recursive: true, force: true }); });

/** Повертає текст помилки навігації або null (успіх + заголовок). */
async function nav(url: string, extraCa: string | undefined): Promise<{ err: string | null; title: string | null }> {
  const prev = process.env.SITELENS_EXTRA_CA_FILE;
  if (extraCa) process.env.SITELENS_EXTRA_CA_FILE = extraCa; else delete process.env.SITELENS_EXTRA_CA_FILE;
  try {
    const sb = await secureLaunch({ mode: "prod", resolver, dial });
    try {
      const ctx = await sb.newContext();
      const page = await ctx.newPage();
      try { await page.goto(url, { timeout: 20000 }); return { err: null, title: await page.title() }; }
      catch (e) { return { err: (e as Error).message.split("\n")[0]!, title: null }; }
    } finally { await sb.close(); }
  } finally { if (prev === undefined) delete process.env.SITELENS_EXTRA_CA_FILE; else process.env.SITELENS_EXTRA_CA_FILE = prev; }
}

describe("DEV-90 SITELENS_EXTRA_CA_FILE", () => {
  it("за замовчуванням прапорця немає; з файлом — SPKI SHA-256 base64 кожного сертифіката", () => {
    expect(secureChromiumArgs("http://127.0.0.1:1", "").some((a) => a.includes("spki"))).toBe(false);
    const f = path.join(tmp, "caA.pem");
    const want = createHash("sha256").update(new X509Certificate(readFileSync(f)).publicKey.export({ type: "spki", format: "der" })).digest("base64");
    expect(extraCaSpkiHashes(f)).toEqual([want]);
    expect(secureChromiumArgs("http://127.0.0.1:1", f)).toContain(`--ignore-certificate-errors-spki-list=${want}`);
    expect(() => extraCaSpkiHashes(path.join(tmp, "nope.pem"))).toThrow();
    writeFileSync(path.join(tmp, "junk.pem"), "not a cert");
    expect(() => extraCaSpkiHashes(path.join(tmp, "junk.pem"))).toThrow(/немає PEM/);
  });

  it("контроль: без змінної сервер із листом від CA A відхиляється", async () => {
    currentLeaf = "leafA";
    const r = await nav("https://site.test/", undefined);
    expect(r.err).toMatch(/ERR_CERT_AUTHORITY_INVALID/);
  }, 60000);

  it("з CA A у файлі лист від A довіряється (позитив)", async () => {
    currentLeaf = "leafA";
    const r = await nav("https://site.test/", path.join(tmp, "caA.pem"));
    expect(r).toEqual({ err: null, title: "ok-tls" });
  }, 60000);

  it("довіра НЕ розширена: лист від іншого CA B відхиляється навіть із прапорцем для A", async () => {
    currentLeaf = "leafB";
    const r = await nav("https://site.test/", path.join(tmp, "caA.pem"));
    expect(r.err).toMatch(/ERR_CERT_AUTHORITY_INVALID/);
  }, 60000);

  const live = process.env.SITELENS_EXTRA_CA_FILE;
  it.skipIf(!live)("жива мережа: gov.uk/robots.txt — з прапорцем вантажиться, без — ERR_CERT_AUTHORITY_INVALID", async () => {
    const liveNav = async (ca: string | undefined) => {
      const prev = process.env.SITELENS_EXTRA_CA_FILE;
      if (ca) process.env.SITELENS_EXTRA_CA_FILE = ca; else delete process.env.SITELENS_EXTRA_CA_FILE;
      try {
        const sb = await secureLaunch({ mode: "prod" });
        try {
          const page = await (await sb.newContext()).newPage();
          try { const resp = await page.goto("https://www.gov.uk/robots.txt", { timeout: 30000 }); return { err: null, status: resp?.status() ?? 0, body: (await page.content()).slice(0, 4000) }; }
          catch (e) { return { err: (e as Error).message.split("\n")[0]!, status: 0, body: "" }; }
        } finally { await sb.close(); }
      } finally { if (prev === undefined) delete process.env.SITELENS_EXTRA_CA_FILE; else process.env.SITELENS_EXTRA_CA_FILE = prev; }
    };
    const without = await liveNav(undefined);
    expect(without.err).toMatch(/ERR_CERT_AUTHORITY_INVALID/);
    const withCa = await liveNav(live);
    expect(withCa.err).toBeNull();
    // TLS пройдено; HTTP-статус залежить від політики egress середовища (у хмарному середовищі прямий шлях дає 403 host_not_allowed) — лише лог.
    console.log(`gov.uk/robots.txt with extra CA: HTTP ${withCa.status}`);
    expect(withCa.status).toBeGreaterThan(0);
  }, 120000);
});
