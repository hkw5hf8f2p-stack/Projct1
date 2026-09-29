import net from "node:net";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { chromium } from "playwright";

function inodeFor(localPort: number, remotePort: number): { inode: string; uid: number } | null {
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = readFileSync(f, "utf8").split("\n").slice(1);
    for (const l of lines) {
      const p = l.trim().split(/\s+/);
      if (p.length < 10) continue;
      const lp = parseInt(p[1]!.split(":")[1]!, 16), rp = parseInt(p[2]!.split(":")[1]!, 16);
      if (lp === localPort && rp === remotePort) return { inode: p[9]!, uid: Number(p[7]) };
    }
  }
  return null;
}
function ownerPid(inode: string): { pid: number | null; unreadable: number[] } {
  const unreadable: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${d}/fd`); } catch { unreadable.push(Number(d)); continue; }
    for (const fd of fds) { try { if (readlinkSync(`/proc/${d}/fd/${fd}`) === `socket:[${inode}]`) return { pid: Number(d), unreadable }; } catch {} }
  }
  return { pid: null, unreadable };
}
const ppid = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
const srv = net.createServer((s) => {
  const t0 = performance.now();
  const r = inodeFor(s.remotePort!, (srv.address() as net.AddressInfo).port);
  const o = r ? ownerPid(r.inode) : null;
  let chain: number[] = [];
  if (o?.pid) { let p = o.pid; while (p > 1) { chain.push(p); p = ppid(p); } }
  console.log(JSON.stringify({ remotePort: s.remotePort, r, owner: o?.pid, unreadableCount: o?.unreadable.length, chain, self: process.pid, ms: performance.now() - t0 }));
  s.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as net.AddressInfo).port;
const b = await chromium.launch({ chromiumSandbox: true, args: [`--proxy-server=http://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>"] });
const p = await b.newPage();
await p.goto("http://example.test/").catch((e) => console.log("goto", String(e).slice(0, 80)));
await b.close(); srv.close();
