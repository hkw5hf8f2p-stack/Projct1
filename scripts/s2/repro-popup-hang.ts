/**
 * REPRO (знахідка S2 для S1b): сторінка з `window.open(...)` при `captureViewport` інколи (≈ 1–2 із 6) не завершується до 60-с watchdog.
 * Запуск: bash scripts/run-as-sitelens.sh pnpm exec tsx scripts/s2/repro-popup-hang.ts   → друкує ok/hang для варіантів сторінки.
 * Спроба закривати popup у контексті (ctx.on('page') → p.close()) ПОГІРШИЛА картину (≈ 10 з 20) — не допомагає.
 */
import { secureLaunch } from "../../packages/browser/src/secure-launch.js";
import { captureViewport } from "../../packages/browser/src/audit/capture-page.js";
import { startCanary } from "./ssrf.js";
import http from "node:http";
const canary = await startCanary(4399);
import { probeHtml } from "./ssrf.js";
const withOpen = (h: string) => h.replace("</script></main>", "try { window.open(\"http://127.0.0.2:4399/v23-window-open\"); } catch (e) {}\n</script></main>");
const variants: Record<string, (h: string) => string> = {
  with_window_open: withOpen,
  without_window_open: (h) => h,
};
const sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: ["http://127.0.0.1:4398"] });
for (const [name, fn] of Object.entries(variants)) {
  const html = fn(probeHtml("http://127.0.0.2:4399"));
  const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); });
  await new Promise<void>((r) => srv.listen(4398, "127.0.0.1", () => r()));
  let hang = 0, ok = 0;
  for (let i = 0; i < Number(process.env.N ?? 6); i++) {
    try { await Promise.race([captureViewport({ secure: sb, url: "http://127.0.0.1:4398/", vp: "D", runDir: "/tmp/probe5run", pageId: "index", writeShots: false, tiles: false, lockWindowOpen: process.env.LOCK !== "0" }), new Promise((_, rej) => setTimeout(() => rej(new Error("HANG")), Number(process.env.T ?? 8000)))]); ok++; } catch { hang++; console.log("HANG_MARK", i); }
  }
  console.log(name, "ok", ok, "hang", hang);
  srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r()));
}
await sb.close();
await canary.close();
process.exit(0);
