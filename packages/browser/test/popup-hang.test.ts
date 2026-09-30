/**
 * S2-борг: window.open під час завантаження вішав captureViewport (page.goto 'load' не завершувався до 60-с watchdog).
 * Виправлення: WINDOW_OPEN_LOCK_SCRIPT (popup не створюється). 20/20 без зависання; КОНТРОЛЬ (lockWindowOpen:false) — зависання відтворюється.
 * Причина не досліджена на рівні Chromium (unverified): виміряно repro (S4): без window.open 0/92 зависань; з window.open без замка 19/62 (≈ 31 %); із замком 0/50. Лог DEBUG=pw:api: `page.goto started` без `succeeded`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCanary, probeHtml, type Canary } from "../../../scripts/s2/ssrf.js";
import { captureViewport } from "../src/audit/capture-page.js";
import { secureLaunch, type SecureBrowser } from "../src/secure-launch.js";

let canary: Canary;
let srv: http.Server;
let origin = "";
let sb: SecureBrowser;
const runDir = mkdtempSync(path.join(os.tmpdir(), "sl-popup-"));

beforeAll(async () => {
  canary = await startCanary(0);
  const html = probeHtml(`http://127.0.0.2:${canary.port}`).replace("</script></main>", `try { window.open("http://127.0.0.2:${canary.port}/v23-window-open"); } catch (e) {}\n</script></main>`);
  srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin] });
});
afterAll(async () => { await sb?.close(); srv?.closeAllConnections(); srv?.close(); await canary?.close(); });

/** true — завершилось, false — «завис» (>6 с; штатний watchdog 60 с) */
async function once(lock: boolean): Promise<boolean> {
  const p = captureViewport({ secure: sb, url: origin + "/", vp: "D", runDir, pageId: "index", writeShots: false, tiles: false, lockWindowOpen: lock });
  p.catch(() => undefined);
  return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 6000))]);
}

describe("window.open не вішає captureViewport", () => {
  it("20/20 захоплень із замком завершуються; канарка 0 звернень (popup не робить запитів)", async () => {
    let ok = 0;
    for (let i = 0; i < 20; i++) if (await once(true)) ok++;
    expect(ok).toBe(20);
    expect(canary.hits).toEqual([]);
  }, 120_000);

  it("КОНТРОЛЬ без замка: зависання відтворюється (≥ 1 із 25 спроб) — перевірка вміє впасти", async () => {
    let hang = 0;
    for (let i = 0; i < 25 && hang === 0; i++) if (!(await once(false))) hang++;
    expect(hang).toBeGreaterThanOrEqual(1);
  }, 200_000);
});
