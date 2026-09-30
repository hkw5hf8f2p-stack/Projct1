/**
 * Автентифікація клієнтів локального egress-проксі (S1b, ssrf-core «відкрите» п.7).
 *
 * Проблема: проксі слухає 127.0.0.1 — будь-який локальний процес міг би ходити ним у мережу від імені worker.
 * Рішення (Linux): peer-check — власник клієнтського TCP-сокета має бути СТРОГИМ нащадком процесу worker
 * (Chromium Playwright і Chrome Lighthouse запускаються саме ним). Власника знаходимо через /proc:
 *   /proc/net/tcp{,6}: рядок, де local port = порт клієнта, remote port = порт проксі → inode сокета;
 *   далі — /proc/<pid>/fd/* нащадків worker шукаємо `socket:[inode]`.
 * Альтернатива для довірених клієнтів у самому worker (Node-код, тести) — токен у `Proxy-Authorization`.
 * Без /proc (macOS) peer-check недоступний — див. `peerCheckAvailable()` і THREAT_MODEL (залишковий ризик).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";

export function peerCheckAvailable(): boolean {
  try {
    readFileSync("/proc/net/tcp", "utf8");
    readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** inode сокета клієнта, що підключився з `clientPort` до `serverPort` (loopback). */
export function socketInode(clientPort: number, serverPort: number): { inode: string; uid: number } | null {
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      const lp = parseInt(p[1]!.split(":").at(-1)!, 16);
      const rp = parseInt(p[2]!.split(":").at(-1)!, 16);
      if (lp === clientPort && rp === serverPort && p[9] !== "0") return { inode: p[9]!, uid: Number(p[7]) };
    }
  }
  return null;
}

function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // поле comm може містити пробіли й дужки — беремо після останньої ")"
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[1]);
  } catch {
    return null;
  }
}

/** Усі строгі нащадки `root` (за ppid). */
export function descendantsOf(root: number): Set<number> {
  const children = new Map<number, number[]>();
  if (!existsSync("/proc/self")) return descendantsViaPs(root); // macOS/BSD: /proc немає
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    const pp = parentOf(pid);
    if (pp === null) continue;
    const list = children.get(pp) ?? [];
    list.push(pid);
    children.set(pp, list);
  }
  const out = new Set<number>();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

/** macOS/BSD: дерево процесів з `ps -Ao pid=,ppid=` (без /proc). */
function descendantsViaPs(root: number): Set<number> {
  const children = new Map<number, number[]>();
  let lines: string[] = [];
  try {
    lines = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" }).split("\n");
  } catch {
    return new Set();
  }
  for (const l of lines) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(l);
    if (!m) continue;
    const list = children.get(Number(m[2])) ?? [];
    list.push(Number(m[1]));
    children.set(Number(m[2]), list);
  }
  const out = new Set<number>();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

export interface PeerVerdict {
  allowed: boolean;
  owner_pid: number | null;
  reason: string;
}

/** Чи належить клієнтський сокет строгому нащадку `root` (за замовчуванням — цього процесу). */
export function checkPeer(clientPort: number, serverPort: number, root = process.pid): PeerVerdict {
  const s = socketInode(clientPort, serverPort);
  if (!s) return { allowed: false, owner_pid: null, reason: "сокет клієнта не знайдено в /proc/net/tcp" };
  if (typeof process.getuid === "function" && s.uid !== process.getuid())
    return { allowed: false, owner_pid: null, reason: `сокет належить іншому uid (${s.uid})` };
  const target = `socket:[${s.inode}]`;
  for (const pid of descendantsOf(root)) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return { allowed: true, owner_pid: pid, reason: `pid ${pid} — нащадок worker ${root}` };
      } catch {
        /* fd закрився між readdir і readlink */
      }
    }
  }
  return { allowed: false, owner_pid: null, reason: `власник сокета не є нащадком worker ${root}` };
}
