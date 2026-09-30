import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, it } from "vitest";
import type { BrowserContext } from "playwright";
import { applyContextGuards, SECURE_CONTEXT_DEFAULTS, secureLaunch, type BlockedRequest } from "../src/secure-launch.js";

const post = (v: string) => `fetch("/wk-post/${v}", { method: "POST", body: "x" }).then(r => r.status, e => "err:" + e)`;
const W = (v: string) => `(${post(v)}).then(s => { try { postMessage(String(s)); } catch (e) {} }); self.onconnect = (e) => { ${post(v + "-c")}.then(s => e.ports[0].postMessage(String(s))); };`;
const NESTED = `const w = new Worker("/wk-inner.js"); w.onmessage = (e) => postMessage("inner:" + e.data); w.onerror = (e) => postMessage("innererr");`;
const VARIANTS: Record<string, string> = {
  dedicated: `new Worker("/wk-dedicated.js")`,
  module: `new Worker("/wk-module.js", { type: "module" })`,
  blob: `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(W("blob"))}], { type: "text/javascript" })))`,
  nested: `new Worker("/wk-nested.js")`,
  "iframe-dedicated": `(() => { const f = document.createElement("iframe"); document.body.appendChild(f); return new f.contentWindow.Worker("/wk-iframe-dedicated.js"); })()`,
  shared: `new SharedWorker("/wk-shared.js")`,
  "shared-module": `new SharedWorker("/wk-shared-module.js", { type: "module" })`,
  "shared-blob": `new SharedWorker(URL.createObjectURL(new Blob([${JSON.stringify(W("shared-blob"))}], { type: "text/javascript" })))`,
  "iframe-shared": `(() => { const f = document.createElement("iframe"); document.body.appendChild(f); return new f.contentWindow.SharedWorker("/wk-iframe-shared.js"); })()`,
  "nested-iframe-shared": `(() => { const f = document.createElement("iframe"); document.body.appendChild(f); const g = f.contentDocument.createElement("iframe"); f.contentDocument.body.appendChild(g); return new g.contentWindow.SharedWorker("/wk-nested-iframe-shared.js"); })()`,
  "srcdoc-shared": `(() => { const f = document.createElement("iframe"); f.srcdoc = "<script>try{ new SharedWorker('/wk-srcdoc-shared.js'); parent.__s='made' }catch(e){ parent.__s='throw:'+e }<\\/script>"; document.body.appendChild(f); return null; })()`,
};
const page = (v: string) => `<!doctype html><body><script>
window.__r = "pending";
try { const w = ${VARIANTS[v]}; window.__r = "made:" + (w && w.constructor && w.constructor.name);
  if (w && w.port) { w.port.onmessage = (e) => window.__r = "msg:" + e.data; w.port.start(); }
  else if (w) w.onmessage = (e) => window.__r = "msg:" + e.data;
} catch (e) { window.__r = "throw:" + e; }
</script>`;

let srv: http.Server;
let origin = "";
const req: Array<{ run: string; method: string; path: string; dest?: string }> = [];
let run = "";
beforeAll(async () => {
  srv = http.createServer((q, r) => {
    const p = q.url ?? "";
    req.push({ run, method: q.method ?? "?", path: p, dest: String(q.headers["sec-fetch-dest"] ?? "") });
    const m = /^\/p-([\w-]+)\.html/.exec(p);
    if (m) return void r.writeHead(200, { "content-type": "text/html" }).end(page(m[1]!));
    if (p === "/wk-nested.js") return void r.writeHead(200, { "content-type": "text/javascript" }).end(NESTED);
    const j = /^\/wk-([\w-]+)\.js/.exec(p);
    if (j) return void r.writeHead(200, { "content-type": "text/javascript" }).end(W(j[1]!));
    r.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(async () => {
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

async function drive(name: string, f: () => Promise<BrowserContext>) {
  const out: Record<string, string> = {};
  for (const v of Object.keys(VARIANTS)) {
    run = `${name}:${v}`;
    const ctx = await f();
    const p = await ctx.newPage();
    await p.goto(`${origin}/p-${v}.html`).catch(() => {});
    await p.waitForTimeout(1500);
    out[v] = await p.evaluate(() => (window as unknown as { __r: string; __s?: string }).__r + " " + ((window as unknown as { __s?: string }).__s ?? "")).catch((e) => String(e).slice(0, 60));
    await ctx.close();
  }
  return out;
}

it("probe", async () => {
  const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
  const blocked: BlockedRequest[] = [];
  try {
    const cur = await drive("cur", () => sb.newContext());
    const raw = await drive("raw", async () => sb.browser.newContext(SECURE_CONTEXT_DEFAULTS));
    void applyContextGuards;
    console.log("CUR", JSON.stringify(cur, null, 1)); console.log("RAW", JSON.stringify(raw, null, 1)); console.log("BLOCKED", sb.blocked.map((b) => `${b.kind} ${b.method} ${b.url} ${b.resource_type}`).join("\n")); console.log("REQ", req.filter((r) => !r.path.endsWith(".html")).map((r) => `${r.run} ${r.method} ${r.path} ${r.dest}`).join("\n"));
  } finally {
    await sb.close();
  }
}, 120_000);
