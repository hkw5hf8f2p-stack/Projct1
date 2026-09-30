/**
 * S1b-Fix (critic S1b-1, DEV-50, threat-model T-7b): не-GET до цілі з JS-контекстів воркерів.
 *
 * Кожна сторінка-варіант створює воркер, який робить `fetch(POST)` на ту саму ціль (`/wk-post/<variant>`); SharedWorker
 * додатково робить POST на `connect`. Ціль — локальний HTTP-сервер, що рахує КОЖЕН отриманий запит (артефакт = лог цілі).
 *
 * Прогони (ті самі сторінки):
 *   raw    — контекст без шару 2 (SECURE_CONTEXT_DEFAULTS, без route/init-script) → POST доходить з УСІХ варіантів
 *            (детектор «ціль отримала не-GET» уміє впасти для кожного варіанта);
 *   old    — шар 2 як до S1b-Fix (route + SW lockdown, БЕЗ SharedWorker lockdown) → dedicated-клас: 0 POST (Playwright
 *            маршрутизує мережу dedicated Worker через context.route), shared-клас: POST доходить (знахідка критика);
 *   secure — `SecureBrowser.newContext()` → 0 не-GET до цілі; SharedWorker → SecurityError (скрипт воркера навіть не
 *            запитується); спроби POST із dedicated-воркерів — у `blocked` (kind=method).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyContextGuards, SECURE_CONTEXT_DEFAULTS, secureLaunch, type BlockedRequest, type SecureBrowser } from "../src/secure-launch.js";
import { artifactDir } from "../../../scripts/artifact-dir.js";

const ART = artifactDir("sprint-1b/ssrf");

/** Тіло воркера: POST на старті + POST на connect (SharedWorker). ORIGIN — і для blob:-URL (відносний URL там не парситься). */
const post = (v: string) => `fetch(ORIGIN + "/wk-post/${v}", { method: "POST", body: "state-change" }).then((r) => String(r.status), (e) => "err:" + e.name)`;
const WORKER = (v: string) =>
  `const ORIGIN = self.location.protocol === "blob:" ? new URL(self.location.pathname).origin : self.location.origin;
${post(v)}.then((s) => { try { postMessage(s); } catch (e) {} });
self.onconnect = (e) => { ${post(v + "-connect")}.then((s) => e.ports[0].postMessage(s)); };`;
const NESTED_OUTER = `const w = new Worker("/wk-nested-inner.js"); w.onmessage = (e) => postMessage("inner:" + e.data);`;

type Klass = "dedicated" | "shared";
const iframe = (depth: number) =>
  `(() => { let d = document; let w = window; for (let i = 0; i < ${depth}; i++) { const f = d.createElement("iframe"); d.body.appendChild(f); w = f.contentWindow; d = f.contentDocument; } return w; })()`;
const VARIANTS: Record<string, { klass: Klass; make: string; title: string }> = {
  dedicated: { klass: "dedicated", title: "new Worker(url)", make: `new Worker("/wk-dedicated.js")` },
  module: { klass: "dedicated", title: "new Worker(url, {type:'module'})", make: `new Worker("/wk-module.js", { type: "module" })` },
  blob: { klass: "dedicated", title: "new Worker(URL.createObjectURL(blob))", make: `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER("blob"))}], { type: "text/javascript" })))` },
  nested: { klass: "dedicated", title: "Worker → вкладений Worker", make: `new Worker("/wk-nested.js")` },
  "iframe-dedicated": { klass: "dedicated", title: "Worker з about:blank-iframe (realm iframe)", make: `new Promise((res) => { const f = document.createElement("iframe"); f.onload = () => setTimeout(() => res(new f.contentWindow.Worker("/wk-iframe-dedicated.js")), 200); document.body.appendChild(f); })` },
  shared: { klass: "shared", title: "new SharedWorker(url)", make: `new SharedWorker("/wk-shared.js")` },
  "shared-module": { klass: "shared", title: "new SharedWorker(url, {type:'module'})", make: `new SharedWorker("/wk-shared-module.js", { type: "module" })` },
  "shared-blob": { klass: "shared", title: "new SharedWorker(URL.createObjectURL(blob))", make: `new SharedWorker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER("shared-blob"))}], { type: "text/javascript" })))` },
  "iframe-shared": { klass: "shared", title: "SharedWorker з about:blank-iframe", make: `new (${iframe(1)}).SharedWorker("/wk-iframe-shared.js")` },
  "nested-iframe-shared": { klass: "shared", title: "SharedWorker з about:blank-iframe усередині about:blank-iframe", make: `new (${iframe(2)}).SharedWorker("/wk-nested-iframe-shared.js")` },
  "proto-shared": { klass: "shared", title: "конструктор з iframe через Object.getOwnPropertyDescriptor + Reflect.construct", make: `Reflect.construct(Object.getOwnPropertyDescriptor(${iframe(1)}, "SharedWorker").value, ["/wk-proto-shared.js"])` },
  "srcdoc-shared": {
    klass: "shared",
    title: "SharedWorker зі srcdoc-iframe (власний скрипт документа)",
    make: `(() => { const f = document.createElement("iframe"); f.srcdoc = "<script>try { const w = new SharedWorker('/wk-srcdoc-shared.js'); w.port.onmessage = (e) => parent.__r = 'msg:' + e.data; w.port.start(); parent.__r = 'made:SharedWorker'; } catch (e) { parent.__r = 'throw:' + e.name; }<\\/script>"; document.body.appendChild(f); return "srcdoc"; })()`,
  },
  "popup-shared": { klass: "shared", title: "SharedWorker з window.open('') popup", make: `new (window.open("") || window).SharedWorker("/wk-popup-shared.js")` },
};
/**
 * Сторінка-варіант. `make` — вираз, що дає worker/port-власника АБО Promise від нього. "iframe-dedicated" створює Worker через 200 мс
 * ПІСЛЯ `load` iframe: у Chromium `load` для about:blank спрацьовує під час appendChild, а початковий документ потім асинхронно
 * підміняється — воркер, створений у тимчасовому realm, отримує GET скрипта, але ніколи не виконує fetch/postMessage. Це була
 * справжня причина флейку (30.09: ~6/25 прогонів; ціль бачила лише `GET /wk-iframe-dedicated.js`, POST не було навіть у raw;
 * з паузою 25/25). Shared-варіанти без паузи лишаються навмисно: їхній очікуваний результат (SecurityError у secure) від realm не залежить.
 */
const page = (v: string) => `<!doctype html><title>${v}</title><body><script>
window.__r = "pending";
const attach = (w) => {
  if (w === "srcdoc") return;
  window.__w = w; // жорстке посилання: воркер не має бути зібраний GC до відповіді
  window.__r = "made:" + w.constructor.name;
  if (w.port) { w.port.onmessage = (e) => window.__r = "msg:" + e.data; w.port.start(); } else w.onmessage = (e) => window.__r = "msg:" + e.data;
};
try { Promise.resolve(${VARIANTS[v]!.make}).then(attach, (e) => { window.__r = "throw:" + e.name; }); }
catch (e) { window.__r = "throw:" + e.name; }
</script>`;

interface Req { run: string; method: string; path: string; dest: string }
const reqs: Req[] = [];
let run = "";
let srv: http.Server;
let origin = "";
let sb: SecureBrowser;

beforeAll(async () => {
  srv = http.createServer((q, r) => {
    const p = (q.url ?? "").split("?")[0]!;
    reqs.push({ run, method: q.method ?? "?", path: p, dest: String(q.headers["sec-fetch-dest"] ?? "") });
    const m = /^\/p-([\w-]+)\.html$/.exec(p);
    if (m && VARIANTS[m[1]!]) return void r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(m[1]!));
    if (p === "/wk-nested.js") return void r.writeHead(200, { "content-type": "text/javascript" }).end(NESTED_OUTER);
    const j = /^\/wk-([\w-]+)\.js$/.exec(p);
    if (j) return void r.writeHead(200, { "content-type": "text/javascript" }).end(WORKER(j[1]!));
    r.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
  mkdirSync(ART, { recursive: true });
});
afterAll(async () => {
  await sb?.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

/**
 * Усі варіанти паралельно в одному контексті (URL воркерів унікальні → SharedWorker не діляться між варіантами).
 * Сигнал завершення спроби — `window.__r` = "msg:<відповідь воркера>" (воркер повідомив результат POST через postMessage)
 * або "throw:<ім'я>" (конструктор відмовив). Тайм-аут НЕ ковтається: він падає тестом з іменем варіанта (без вакуумних 0 POST).
 */
async function drive(name: string, ctx: BrowserContext): Promise<Record<string, string>> {
  run = name;
  const out: Record<string, string> = {};
  const failures: string[] = [];
  try {
    await Promise.all(
      Object.keys(VARIANTS).map(async (v) => {
        try {
          const p = await ctx.newPage();
          await p.goto(`${origin}/p-${v}.html`);
          await p.waitForFunction(() => /^(msg|throw):/.test((window as unknown as { __r: string }).__r), undefined, { timeout: 30_000 });
          out[v] = await p.evaluate(() => (window as unknown as { __r: string }).__r);
        } catch (e) {
          const seen = reqs.filter((r) => r.run === name && r.path.includes(v)).map((r) => `${r.method} ${r.path}`);
          failures.push(`[${name}/${v}] спроба не завершилась сигналом: ${String(e).split("\n")[0]!.slice(0, 160)}; побачено ціллю: ${JSON.stringify(seen)}`);
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 500)); // хвіст запитів із воркерів (POST на connect у SharedWorker)
  } finally {
    await ctx.close();
    run = "";
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return out;
}

const variantOf = (p: string) => Object.keys(VARIANTS).find((v) => p === `/wk-post/${v}` || p === `/wk-post/${v}-connect` || (v === "nested" && p === "/wk-post/nested-inner"));
function summary(name: string) {
  const mine = reqs.filter((r) => r.run === name);
  const nonGet = mine.filter((r) => r.method !== "GET" && r.method !== "HEAD");
  const per: Record<string, { non_get_to_target: number; worker_script_get: number }> = {};
  for (const v of Object.keys(VARIANTS)) per[v] = { non_get_to_target: 0, worker_script_get: 0 };
  for (const r of nonGet) {
    const v = variantOf(r.path);
    if (v) per[v]!.non_get_to_target++;
  }
  for (const r of mine) {
    const j = /^\/wk-([\w-]+?)(?:-inner)?\.js$/.exec(r.path);
    if (j && per[j[1]!]) per[j[1]!]!.worker_script_get++;
  }
  return { non_get_total: nonGet.length, non_get: nonGet.map((r) => `${r.method} ${r.path}`), per };
}
const byKlass = (per: Record<string, { non_get_to_target: number }>, k: Klass) => Object.entries(per).filter(([v]) => VARIANTS[v]!.klass === k);

describe("worker-bypass: не-GET до цілі з Worker / SharedWorker (S1b-Fix, DEV-50)", () => {
  const results: Record<string, unknown> = {};
  afterAll(() => {
    writeFileSync(path.join(ART, "worker-bypass.json"), JSON.stringify({ schema: "sitelens-worker-bypass/v1", variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, `${v.klass}: ${v.title}`])), ...results }, null, 1) + "\n");
  });

  it("контроль raw (без шару 2): POST доходить до цілі з КОЖНОГО варіанта — детектор уміє впасти", async () => {
    const page = await drive("raw", await sb.browser.newContext(SECURE_CONTEXT_DEFAULTS));
    const s = summary("raw");
    results.raw = { page, ...s };
    for (const [v, c] of Object.entries(s.per)) {
      expect(c.non_get_to_target, `raw/${v}: POST дійшов до цілі`).toBeGreaterThan(0);
      expect(page[v], `raw/${v}: воркер повідомив статус POST`).toMatch(/^msg:(inner:)?200$/);
    }
  }, 120_000);

  it("контроль old (шар 2 до S1b-Fix, без SharedWorker lockdown): dedicated-клас 0 POST, shared-клас — POST дійшов", async () => {
    const ctx = await sb.browser.newContext(SECURE_CONTEXT_DEFAULTS);
    const blocked: BlockedRequest[] = [];
    await applyContextGuards(ctx, blocked, { sharedWorkerLockdown: false });
    const page = await drive("old", ctx);
    const s = summary("old");
    results.old = { page, ...s, layer2_blocked: blocked.map((b) => `${b.kind} ${b.method} ${new URL(b.url).pathname}`) };
    for (const [v, c] of byKlass(s.per, "dedicated")) expect(c.non_get_to_target, v).toBe(0);
    for (const [v, c] of byKlass(s.per, "shared")) expect(c.non_get_to_target, v).toBeGreaterThan(0);
    // dedicated: спроба POST видна шару 2 (не «тихо не відбулась»)
    for (const v of Object.keys(VARIANTS).filter((k) => VARIANTS[k]!.klass === "dedicated"))
      expect(blocked.some((b) => b.kind === "method" && b.method === "POST" && new URL(b.url).pathname.startsWith(`/wk-post/${v === "nested" ? "nested-inner" : v}`)), v).toBe(true);
  }, 120_000);

  it("SecureBrowser: 0 не-GET до цілі з усіх 13 варіантів; SharedWorker → SecurityError, його скрипт не запитано", async () => {
    const before = sb.blocked.length;
    const page = await drive("secure", await sb.newContext());
    const s = summary("secure");
    const blocked = sb.blocked.slice(before);
    results.secure = { page, ...s, layer2_blocked: blocked.map((b) => `${b.kind} ${b.method} ${new URL(b.url).pathname}`) };
    expect(s.non_get).toEqual([]);
    for (const [v] of byKlass(s.per, "shared")) {
      expect(page[v], v).toBe("throw:SecurityError");
      expect(s.per[v]!.worker_script_get, v).toBe(0);
    }
    for (const [v] of byKlass(s.per, "dedicated")) expect(page[v], v).toMatch(/err:TypeError/);
    expect(blocked.filter((b) => b.kind === "method" && b.method === "POST").length).toBeGreaterThanOrEqual(byKlass(s.per, "dedicated").length);
  }, 120_000);

  it("init-script: SharedWorker на globalThis non-writable/non-configurable — перевизначення й delete не повертають конструктор", async () => {
    const ctx = await sb.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(`${origin}/p-dedicated.html`).catch(() => {});
      const r = await p.evaluate(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        const d = Object.getOwnPropertyDescriptor(globalThis, "SharedWorker")!;
        const del = delete g.SharedWorker;
        let redefine = "ok";
        try { Object.defineProperty(globalThis, "SharedWorker", { value: 1 }); } catch (e) { redefine = (e as Error).name; }
        try { g.SharedWorker = function () {}; } catch { /* strict-режим: TypeError — теж ок */ }
        let ctor = "none";
        try { new (g.SharedWorker as new (u: string) => unknown)("/wk-x.js"); ctor = "constructed"; } catch (e) { ctor = (e as Error).name; }
        return { writable: d.writable, configurable: d.configurable, del, redefine, ctor };
      });
      expect(r).toEqual({ writable: false, configurable: false, del: false, redefine: "TypeError", ctor: "SecurityError" });
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
