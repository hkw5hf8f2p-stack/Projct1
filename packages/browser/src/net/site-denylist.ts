/**
 * SITE_DENYLIST (G0-13, R-23): сайти, які dev-прогони НЕ відвідують (насамперед сайт протоколу §66 — він не має
 * «засвітитися» в розробці). Джерело — env `SITELENS_SITE_DENYLIST` (кома/пробіл/новий рядок), поза репо.
 * Запис: ім'я хоста (`example.com` — блокує і всі піддомени) або `sha256:<hex>` від ASCII-імені в нижньому
 * регістрі (щоб у спільному конфігу не розкривати сайт; хеш звіряється з кожним суфіксом імені).
 * Застосовується в egress-проксі до КОЖНОГО з'єднання (не лише стартового URL) і в `assertSiteAllowed` на старті.
 */
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";

export interface SiteDenylist {
  hosts: Set<string>;
  hashes: Set<string>;
}

export const SITE_DENYLIST_ENV = "SITELENS_SITE_DENYLIST";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function canonHost(h: string): string {
  const x = h.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return domainToASCII(x) || x;
}

export function parseSiteDenylist(raw: string | undefined | null): SiteDenylist {
  const out: SiteDenylist = { hosts: new Set(), hashes: new Set() };
  for (const tok of (raw ?? "").split(/[\s,;]+/)) {
    const t = tok.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^sha256:([0-9a-f]{64})$/i.exec(t);
    if (m) {
      out.hashes.add(m[1]!.toLowerCase());
      continue;
    }
    let host = t;
    if (/^[a-z]+:\/\//i.test(t)) host = new URL(t).hostname;
    host = canonHost(host.replace(/^\*\./, "").replace(/^www\./, ""));
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) throw new Error(`${SITE_DENYLIST_ENV}: некоректний запис «${t}»`);
    out.hosts.add(host);
  }
  return out;
}

export function loadSiteDenylist(env: NodeJS.ProcessEnv = process.env): SiteDenylist {
  return parseSiteDenylist(env[SITE_DENYLIST_ENV]);
}

/** Повертає запис, що спрацював, або null. `a.b.example.com` перевіряється як сам і всі суфікси ≥ 2 міток. */
export function matchSiteDenylist(hostRaw: string, list: SiteDenylist): string | null {
  if (list.hosts.size === 0 && list.hashes.size === 0) return null;
  const host = canonHost(hostRaw);
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const suffix = labels.slice(i).join(".");
    if (list.hosts.has(suffix)) return suffix;
    if (list.hashes.has(sha256(suffix))) return `sha256:${sha256(suffix).slice(0, 12)}…`;
  }
  return null;
}

export function assertSiteAllowed(url: string, list: SiteDenylist = loadSiteDenylist()): void {
  const hit = matchSiteDenylist(new URL(url).hostname, list);
  if (hit) throw new Error(`сайт у ${SITE_DENYLIST_ENV} (${hit}) — dev-прогони його не відвідують (G0-13)`);
}

/**
 * Чи заборонений сайт для dev-прогонів (G0-13). Приймає URL або ім'я хоста; некоректний URL → true (fail-closed).
 * Використовується `scripts/audit-live.ts` до запуску браузера; той самий список діє в egress-проксі на кожне з'єднання.
 */
export function isSiteDenied(urlOrHost: string, list: SiteDenylist = loadSiteDenylist()): boolean {
  let host = urlOrHost.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return true;
    }
  }
  if (!host) return true;
  return matchSiteDenylist(host, list) !== null;
}
