import http from "node:http"; import type { AddressInfo } from "node:net";
import { secureLaunch, applyContextGuards, SECURE_CONTEXT_DEFAULTS } from "../src/secure-launch.js";
const hits: string[] = [];
const variant = (v: string) => `<!doctype html><title>${v}</title><script>
window.__r = "pending";
const go = () => {
 try {
  let p;
  if ("${v}" === "instance") p = navigator.serviceWorker.register("/sw-${v}.js");
  if ("${v}" === "proto") p = ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw-${v}.js");
  if ("${v}" === "iframe") { const f = document.createElement("iframe"); document.body.appendChild(f); p = f.contentWindow.ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw-${v}.js"); }
  Promise.resolve(p).then((r) => window.__r = "ok:" + (r ? r.constructor.name : String(r)), (e) => window.__r = "rej:" + e);
 } catch (e) { window.__r = "throw:" + e; }
};
addEventListener("load", go);
</script><body>x</body>`;
const srv0 = http.createServer((q, s) => {
  hits.push(`${q.method} ${q.url}`);
  const m = /^\/p-(\w+)\.html/.exec(q.url!); if (m) { s.setHeader("content-type", "text/html"); return void s.end(variant(m[1]!)); }
  if (q.url!.startsWith("/sw-")) { s.setHeader("content-type", "text/javascript"); return void s.end(`self.addEventListener("install", e => e.waitUntil(Promise.all([fetch("/sw-post-hit${q.url}", {method:"POST", body:"state-change"}).catch(()=>{}), fetch("/sw-get-hit${q.url}").catch(()=>{})]))); try { new WebSocket("ws://" + location.host + "/sw-ws${q.url}"); } catch (e) {}`); }
  s.end("ok");
});
const srv = srv0; srv.on("upgrade", (q, sock) => { hits.push(`UPGRADE ${q.url}`); sock.destroy(); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
const sws: string[] = []; const seen: string[] = [];
for (const v of ["instance", "proto", "iframe"]) {
  const ctx = process.env.SWMODE === "allow" ? await sb.browser.newContext({ ...SECURE_CONTEXT_DEFAULTS, serviceWorkers: "allow" }) : await sb.newContext();
  if (process.env.SWMODE === "allow") await applyContextGuards(ctx, sb.blocked, { swLockdown: false });
  ctx.on("serviceworker", (w) => sws.push(`${v}: ${w.url()}`));
  await ctx.route("**/*", (r, q) => { seen.push(`${v} ${q.method()} ${q.url().replace(origin, "")} sw=${q.headers()["service-worker"] ?? "-"} type=${q.resourceType()}`); return r.fallback(); });
  const p = await ctx.newPage();
  await p.goto(`${origin}/p-${v}.html`); await p.waitForTimeout(2000);
  console.log(v, await p.evaluate(() => (window as any).__r));
  await ctx.close();
}
console.log("server hits", hits.filter(h => !h.includes(".html")));
console.log("layer2 blocked", sb.blocked.map(b => `${b.method} ${b.url}`));
console.log("sw events", sws); console.log("route saw", seen);
await sb.close(); srv.close();
