import http from "node:http"; import type { AddressInfo } from "node:net";
import { runLighthouseIsolated } from "../src/lighthouse/run-lighthouse.js";
const srv = http.createServer((q, s) => { s.setHeader("content-type","text/html"); s.end(`<!doctype html><html lang=en><title>x</title><h1>Hi</h1><img src="http://127.0.0.2:4199/x.png">`); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
process.env.FAKE_SECRET_X = "sk-fake-123456";
const r = await runLighthouseIsolated({ url: origin + "/", mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [origin], outDir: "/tmp/sl-lh-out", secretsProbe: ["sk-fake-123456"] });
console.log(JSON.stringify({ ...r, proxy_log: r.proxy_log.map(l => [l.decision, l.host, l.port, l.path, l.peer_pid]), evidence: r.evidence.map(e => e.description), chrome: { ...r.chrome, flags: r.chrome.flags.length } }, null, 1));
srv.close();
