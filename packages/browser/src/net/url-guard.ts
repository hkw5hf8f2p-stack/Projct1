/**
 * Нормалізація й статична перевірка URL цілі (до будь-якої мережі).
 * Динамічна перевірка резолвленої IP — у egress-проксі (net/egress-proxy.ts): цей модуль її НЕ замінює.
 */
import { classifyHostname, classifyIpLiteral, type IpVerdict } from "./ip-classify.js";

export type HostKind = "ipv4" | "ipv6" | "domain";

export interface NormalizedUrl {
  ok: true;
  url: string;
  protocol: "http:" | "https:";
  /** Хост у ASCII (IDN → punycode), IPv6 — без дужок. */
  host: string;
  port: number;
  hostKind: HostKind;
  /** Для IP-літерала — вердикт класифікатора; для домену — null (перевіряє проксі після резолву). */
  ip: IpVerdict | null;
}
export interface UrlRejection { ok: false; input: string; reason: string }

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function normalizeTargetUrl(input: string): NormalizedUrl | UrlRejection {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, input, reason: "не абсолютний URL" };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return { ok: false, input, reason: `схема ${u.protocol} не дозволена (лише http/https)` };
  // userinfo: `http://public.com@127.0.0.1/` — класична плутанина парсерів; облікові дані в URL не приймаємо взагалі.
  if (u.username !== "" || u.password !== "") return { ok: false, input, reason: "userinfo (user:pass@) у URL заборонено" };
  // Додатковий захист від `@` у сирому authority, якщо парсер його «з'їв» інакше.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  if (authority.includes("@")) return { ok: false, input, reason: "userinfo (@) в authority заборонено" };
  if (u.hostname === "") return { ok: false, input, reason: "порожній хост" };

  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  const bracketed = u.hostname.startsWith("[");
  const host = bracketed ? u.hostname.slice(1, -1) : u.hostname; // WHATWG вже дав ASCII/punycode і канонічну IPv4
  const lit = classifyIpLiteral(host);
  if (lit) {
    if (!lit.allowed) return { ok: false, input, reason: `IP ${lit.ip} у заблокованому діапазоні ${lit.range}: ${lit.reason}` };
    return { ok: true, url: u.href, protocol: u.protocol as "http:" | "https:", host, port, hostKind: lit.family === 6 ? "ipv6" : "ipv4", ip: lit };
  }
  const hn = classifyHostname(host);
  if (!hn.allowed) return { ok: false, input, reason: hn.reason };
  return { ok: true, url: u.href, protocol: u.protocol as "http:" | "https:", host, port, hostKind: "domain", ip: null };
}

// ---------------------------------------------------------------- deny-list URL дій (G0-11, DEV-12, R-27)

export interface ActionDenyVerdict { denied: boolean; rule: string | null }

/**
 * URL, що навіть через GET можуть змінити стан чужого сайту. Краулер і агент їх не відкривають.
 * Перевіряється шлях і query (після percent-decode, без урахування регістру).
 */
const DENY_URL_RULES: Array<{ rule: string; test: (path: string, query: URLSearchParams, rawQuery: string) => boolean }> = [
  { rule: "query:add-to-cart", test: (_p, q) => [...q.keys()].some((k) => /^add[-_]?to[-_]?cart$/i.test(k)) },
  { rule: "path:add-to-cart", test: (p) => /add[-_]?to[-_]?cart/.test(p) },
  { rule: "path:/cart/add", test: (p) => /\/cart\/(add|update|change|clear)\b/.test(p) },
  { rule: "path:checkout", test: (p) => /(^|\/)checkout(\/|$|\.)/.test(p) },
  { rule: "path:logout", test: (p) => /(^|\/)(log-?out|sign-?out|logoff)(\/|$|\.)/.test(p) },
  { rule: "path:delete", test: (p) => /(^|\/|[-_])(delete|remove|destroy)(\/|$|\.|[-_])/.test(p) },
  { rule: "path:unsubscribe", test: (p) => /unsubscribe/.test(p) },
  { rule: "path:wp-admin", test: (p) => /(^|\/)wp-(admin|login\.php)(\/|$)/.test(p) },
  { rule: "query:action", test: (_p, q) => q.has("action") },
  { rule: "query:state-change", test: (_p, q) => [...q.keys()].some((k) => /^(delete|remove|logout|unsubscribe|remove_item|empty-cart|apply_coupon)$/i.test(k)) },
];

export function isDeniedActionUrl(url: string, base?: string): ActionDenyVerdict {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return { denied: true, rule: "unparseable-url" };
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* лишаємо сирий */
  }
  path = path.toLowerCase();
  for (const r of DENY_URL_RULES) if (r.test(path, u.searchParams, u.search)) return { denied: true, rule: r.rule };
  return { denied: false, rule: null };
}

/** Текст елемента, по якому агент/краулер не клікає (G0-11). EN + UK. */
const DENY_TEXT = [
  /add to (cart|bag|basket)/i, /\bbuy( now)?\b/i, /\bcheckout\b/i, /place order/i, /\bpay\b/i,
  /\blog ?out\b/i, /sign ?out/i, /\bdelete\b/i, /\bremove\b/i, /unsubscribe/i,
  /в кошик/i, /до кошика/i, /купити/i, /оформити/i, /сплатити/i, /оплатити/i, /вийти/i, /видалити/i, /відписатися/i,
];

export function isDeniedActionText(text: string): ActionDenyVerdict {
  const t = text.replace(/\s+/g, " ").trim();
  for (const re of DENY_TEXT) if (re.test(t)) return { denied: true, rule: `text:${re.source}` };
  return { denied: false, rule: null };
}
