import dgram from "node:dgram";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import http from "node:http"; import net from "node:net";
import { chromium } from "playwright";
const hits: string[] = [];
const u = dgram.createSocket("udp4"); u.on("message", (m, r) => hits.push(`${r.address}:${r.port} ${m.length}`));
await new Promise<void>((r) => u.bind(3478, "127.0.0.2", r));
const html = `<!doctype html><title>t</title><link rel="dns-prefetch" href="//leak-probe-abc.test"><img src="http://img-probe-abc.test/x.png"><link rel="preconnect" href="http://preconnect-probe-abc.test"><script>
const pc = new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.2:3478"}]}); pc.createDataChannel("x");
pc.createOffer().then(o=>pc.setLocalDescription(o)); </script>`;
const srv = http.createServer((q, s) => s.end(html)); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as net.AddressInfo).port;
for (const mode of (process.env.MODES||"proxy,noflag").split(",")) {
  hits.length = 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), "nl-")); const nl = path.join(dir, "netlog.json");
  const args = [`--log-net-log=${nl}`, "--net-log-capture-mode=Everything"];
  if (mode === "proxy") args.push(`--proxy-server=http://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic");
  const b = await chromium.launch({ chromiumSandbox: true, args, channel: process.env.CH || undefined });
  const p = await b.newPage();
  // proxy mode: page served through proxy? our srv is not a proxy; load via loopback... with <-loopback> it goes to srv as proxy → srv returns html anyway
  await p.goto(`http://127.0.0.1:${port}/`).catch(e=>console.log(String(e).slice(0,100)));
  await p.waitForTimeout(3000);
  await b.close();
  require_copy: { const fs = await import("node:fs"); fs.copyFileSync(nl, `/tmp/nl-${process.env.CH||"hs"}-${mode}.json`); }
  const txt = existsSync(nl) ? readFileSync(nl, "utf8") : "";
  console.log(mode, "img", txt.includes("img-probe-abc.test"), "stun hits", hits.length, "netlog has leak name", txt.includes("leak-probe-abc.test"), "preconnect", txt.includes("preconnect-probe-abc.test"), "len", txt.length);
  // find event types around name
  const idx = txt.indexOf("leak-probe-abc.test"); if (idx>0) console.log(txt.slice(idx-300, idx+100).replace(/\s+/g," "));
}
u.close(); srv.close();
