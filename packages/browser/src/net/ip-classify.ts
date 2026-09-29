/**
 * SSRF-класифікатор IP-адрес (SPEC §49 + рецензія B1 + IANA special-purpose registries).
 *
 * Політика: адреса дозволена лише якщо вона глобально маршрутизована unicast.
 * - IPv4: блок усього зі списку BLOCKED_V4 (усе з §49 і B1 + решта IANA special-purpose, не «globally reachable»).
 * - IPv6: дозволено лише 2000::/3 (global unicast) мінус спеціальні підмережі BLOCKED_V6; усе поза 2000::/3 —
 *   блок (::1, ::, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96, 64:ff9b::/96 тощо). IPv4-вбудовані форми
 *   (mapped, NAT64, 6to4, Teredo, IPv4-compatible) блокуються цілком (B1) — з причиною, що називає вбудовану IPv4.
 *
 * Модуль чистий (без мережі й DNS) — його використовує egress-проксі на кожне з'єднання.
 */

export type IpFamily = 4 | 6;

export interface IpVerdict {
  ip: string;
  family: IpFamily;
  allowed: boolean;
  /** Назва діапазону, що спрацював (або "global-unicast"). */
  range: string;
  reason: string;
}

interface V4Range { cidr: string; base: number; bits: number; name: string }
interface V6Range { cidr: string; base: bigint; bits: number; name: string }

const v4 = (cidr: string, name: string): V4Range => {
  const [a, b] = cidr.split("/");
  const base = parseIPv4Strict(a!);
  if (base === null) throw new Error(`bad v4 cidr ${cidr}`);
  return { cidr, base, bits: Number(b), name };
};
const v6 = (cidr: string, name: string): V6Range => {
  const [a, b] = cidr.split("/");
  const base = parseIPv6(a!);
  if (base === null) throw new Error(`bad v6 cidr ${cidr}`);
  return { cidr, base, bits: Number(b), name };
};

/** Порядок важливий: вужчі діапазони перед ширшими, щоб причина була точною. */
export const BLOCKED_V4: readonly V4Range[] = [
  v4("0.0.0.0/8", "this-network (B1)"),
  v4("10.0.0.0/8", "private RFC1918 (§49)"),
  v4("100.64.0.0/10", "CGNAT shared RFC6598 (B1; вкл. Alibaba metadata 100.100.100.200)"),
  v4("127.0.0.0/8", "loopback (§49)"),
  v4("169.254.0.0/16", "link-local / cloud metadata 169.254.169.254 (§49)"),
  v4("172.16.0.0/12", "private RFC1918 (§49)"),
  v4("192.0.0.0/24", "IETF protocol assignments RFC6890"),
  v4("192.0.2.0/24", "TEST-NET-1 RFC5737"),
  v4("192.88.99.0/24", "6to4 relay anycast RFC7526"),
  v4("192.168.0.0/16", "private RFC1918 (§49)"),
  v4("198.18.0.0/15", "benchmarking RFC2544"),
  v4("198.51.100.0/24", "TEST-NET-2 RFC5737"),
  v4("203.0.113.0/24", "TEST-NET-3 RFC5737"),
  v4("168.63.129.16/32", "Azure wireserver/metadata (публічна адреса, cloud metadata §49)"),
  v4("224.0.0.0/4", "multicast (B1)"),
  v4("255.255.255.255/32", "limited broadcast"),
  v4("240.0.0.0/4", "reserved class E"),
];

export const BLOCKED_V6: readonly V6Range[] = [
  v6("::/128", "unspecified"),
  v6("::1/128", "loopback (§49)"),
  v6("::ffff:0:0/96", "IPv4-mapped (B1)"),
  v6("::ffff:0:0:0/96", "IPv4-translated RFC2765"),
  v6("::/96", "IPv4-compatible (deprecated)"),
  v6("64:ff9b::/96", "NAT64 well-known (B1)"),
  v6("64:ff9b:1::/48", "NAT64 local-use RFC8215"),
  v6("100::/64", "discard-only RFC6666"),
  v6("2001::/32", "Teredo RFC4380"),
  v6("2001:10::/28", "ORCHID (deprecated)"),
  v6("2001:20::/28", "ORCHIDv2 RFC7343"),
  v6("2001:db8::/32", "documentation RFC3849"),
  v6("2002::/16", "6to4 RFC3056"),
  v6("3fff::/20", "documentation RFC9637"),
  v6("5f00::/16", "SRv6 SIDs RFC9602"),
  v6("fc00::/7", "unique-local (§49; вкл. AWS metadata fd00:ec2::254)"),
  v6("fe80::/10", "link-local (§49)"),
  v6("fec0::/10", "site-local (deprecated)"),
  v6("ff00::/8", "multicast (B1)"),
];

const GLOBAL_UNICAST_V6 = v6("2000::/3", "global unicast");

// ---------------------------------------------------------------- парсери

/** Строгий dotted-quad (лише десяткові, без провідних нулів). */
export function parseIPv4Strict(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * «Поблажливий» IPv4 як inet_aton / WHATWG URL host parser: 1–4 частини, кожна десяткова, вісімкова (0-префікс)
 * або hex (0x), остання частина заповнює решту байтів. `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1` → 127.0.0.1.
 * Повертає null, якщо рядок не є IPv4 у жодному записі (тобто це ім'я хоста).
 */
export function parseIPv4Loose(input: string): number | null {
  let s = input;
  if (s.endsWith(".")) s = s.slice(0, -1); // WHATWG: один кінцевий крапка дозволена
  if (s === "") return null;
  const parts = s.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(p)) v = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9]\d*)$/.test(p)) v = Number(p);
    else return null;
    if (!Number.isFinite(v)) return null;
    nums.push(v);
  }
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return null;
  const restBytes = 4 - nums.length;
  if (last >= 256 ** restBytes) return null;
  let out = 0;
  for (const n of nums) out = out * 256 + n;
  out = out * 256 ** restBytes + last;
  return out >>> 0;
}

export function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** IPv6 → 128-бітне BigInt. Приймає `::`, вбудовану IPv4 в кінці, дужки й zone id (`%eth0` відкидається). */
export function parseIPv6(input: string): bigint | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  let tailV4: number | null = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    tailV4 = parseIPv4Strict(tail);
    if (tailV4 === null) return null;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const toGroups = (x: string) => (x === "" ? [] : x.split(":"));
  const head = toGroups(dbl[0]!);
  const rest = dbl.length === 2 ? toGroups(dbl[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (dbl.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(dbl.length === 2 ? fill : 0).fill("0"), ...rest];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailV4 !== null) out = (out & ~0xffffffffn) | BigInt(tailV4);
  return out;
}

export function formatIPv6(n: bigint): string {
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return g.join(":");
}

const inV4 = (ip: number, r: V4Range) => (r.bits === 0 ? true : ip >>> (32 - r.bits) === r.base >>> (32 - r.bits));
const inV6 = (ip: bigint, r: V6Range) => ip >> BigInt(128 - r.bits) === r.base >> BigInt(128 - r.bits);

/** Для IPv6-форм, що несуть IPv4 — повертає вбудовану IPv4 (для зрозумілої причини в лозі). */
function embeddedV4(ip: bigint): string | null {
  const top96 = ip >> 32n;
  const low = Number(ip & 0xffffffffn);
  if (top96 === 0xffffn || top96 === 0n || top96 === 0xffff0000n || ip >> 32n === 0x0064ff9b0000000000000000n) return formatIPv4(low);
  if (ip >> 112n === 0x2002n) return formatIPv4(Number((ip >> 80n) & 0xffffffffn)); // 6to4
  if (ip >> 96n === 0x20010000n) return formatIPv4(~low >>> 0); // Teredo: клієнтська IPv4 інвертована в нижніх 32 бітах
  return null;
}

// ---------------------------------------------------------------- класифікація

export function classifyIPv4(n: number): IpVerdict {
  const ip = formatIPv4(n);
  for (const r of BLOCKED_V4) if (inV4(n, r)) return { ip, family: 4, allowed: false, range: r.cidr, reason: r.name };
  return { ip, family: 4, allowed: true, range: "global-unicast", reason: "публічна IPv4" };
}

export function classifyIPv6(n: bigint): IpVerdict {
  const ip = formatIPv6(n);
  for (const r of BLOCKED_V6) {
    if (inV6(n, r)) {
      const e = embeddedV4(n);
      return { ip, family: 6, allowed: false, range: r.cidr, reason: e ? `${r.name}; вбудована IPv4 ${e}` : r.name };
    }
  }
  if (!inV6(n, GLOBAL_UNICAST_V6)) return { ip, family: 6, allowed: false, range: "!2000::/3", reason: "IPv6 поза global unicast 2000::/3 (reserved/unassigned)" };
  return { ip, family: 6, allowed: true, range: "global-unicast", reason: "публічна IPv6" };
}

/**
 * Класифікує IP-літерал у будь-якому записі (IPv4 dotted/decimal/octal/hex/short, IPv6 з дужками чи без).
 * Повертає null, якщо рядок — не IP (тоді це ім'я хоста, і його треба резолвити).
 */
export function classifyIpLiteral(host: string): IpVerdict | null {
  const h = host.trim();
  if (h.includes(":") || h.startsWith("[")) {
    const n = parseIPv6(h);
    if (n === null) return { ip: h, family: 6, allowed: false, range: "invalid", reason: "некоректний IPv6-літерал" };
    return classifyIPv6(n);
  }
  const n4 = parseIPv4Loose(h);
  if (n4 !== null) return classifyIPv4(n4);
  // WHATWG «ends in a number»: якщо останній label числовий — хост є IPv4 і мусить розібратись; інакше
  // (256.1.1.1, 0x1g.0.0.1, 4294967296) — не пропускаємо як ім'я.
  const labels = h.replace(/\.$/, "").split(".");
  const lastLabel = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(lastLabel) || /^0x[0-9a-f]*$/i.test(lastLabel)) return { ip: h, family: 4, allowed: false, range: "invalid", reason: "некоректний числовий IPv4-запис" };
  return null;
}

/** Класифікує адресу, що повернув резолвер (завжди канонічна форма). */
export function classifyResolved(address: string, family?: number): IpVerdict {
  if (family === 6 || address.includes(":")) {
    const n = parseIPv6(address);
    return n === null ? { ip: address, family: 6, allowed: false, range: "invalid", reason: "резолвер повернув некоректну IPv6" } : classifyIPv6(n);
  }
  const n = parseIPv4Strict(address);
  return n === null ? { ip: address, family: 4, allowed: false, range: "invalid", reason: "резолвер повернув некоректну IPv4" } : classifyIPv4(n);
}

/** Імена хостів, заборонені до будь-якого резолву (cloud metadata, локальні зони). */
const BLOCKED_HOST_EXACT = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
]);
const BLOCKED_HOST_SUFFIX = [".localhost", ".internal", ".local", ".localdomain", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"];

export function classifyHostname(hostname: string): { allowed: boolean; reason: string } {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "") return { allowed: false, reason: "порожнє ім'я хоста" };
  if (BLOCKED_HOST_EXACT.has(h)) return { allowed: false, reason: `заборонене ім'я хоста ${h} (metadata/loopback)` };
  for (const s of BLOCKED_HOST_SUFFIX) if (h.endsWith(s)) return { allowed: false, reason: `заборонена зона *${s}` };
  if (!h.includes(".")) return { allowed: false, reason: "однокомпонентне ім'я (intranet/search-domain)" };
  return { allowed: true, reason: "ім'я хоста не в deny-list" };
}
