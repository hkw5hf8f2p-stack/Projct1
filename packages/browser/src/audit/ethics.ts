/**
 * Етика звернень до чужих сайтів (DEV-18, DEV-43, G0-14): чесний User-Agent, пауза ≥ 1500 мс між навігаціями до одного хоста,
 * 1 сторінка одночасно на хост, ≤ 5 аудитів на сайт за добу (персистентний лічильник), robots.txt (RFC 9309),
 * лічильник звернень на хост як артефакт прогону. Фікстура: пауза 0 лише з явним прапорцем `fixture`; ліміт за добу
 * для фікстури не рахується. Жодних мережевих викликів тут немає: robots.txt отримує `auditSite` тим самим
 * захищеним браузером (egress-проксі), не прямим fetch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PRODUCT_TOKEN = "SiteLensBot";
export const DEFAULT_CONTACT = "bot-contact@sitelens.invalid";
/** Чесний UA: назва продукту + версія + контакт-плейсхолдер (замінити на реальний перед публічним використанням). */
export const HONEST_USER_AGENT = `${PRODUCT_TOKEN}/0.1 (+https://sitelens.invalid/bot; contact: ${DEFAULT_CONTACT}) audit-only, GET-only`;

export const MIN_DELAY_MS = 1500;
export const MAX_AUDITS_PER_DAY = 5;

// ------------------------------------------------------------------------------------------------ robots.txt
export interface RobotsRule { allow: boolean; pattern: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface RobotsPolicy {
  groups: RobotsGroup[];
  /** статус отримання: ok | none (4xx → усе дозволено) | unreachable (5xx/мережа → усе заборонено, RFC 9309 §2.3.1.4) */
  fetch: "ok" | "none" | "unreachable";
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((key === "allow" || key === "disallow") && cur) cur.rules.push({ allow: key === "allow", pattern: val });
  }
  return groups;
}

/** Група для нашого UA: найдовший збіг токена продукту (підрядок), інакше `*`; кілька груп одного агента зливаються. */
export function groupFor(groups: RobotsGroup[], token = PRODUCT_TOKEN): RobotsRule[] {
  const t = token.toLowerCase();
  let best = -1;
  for (const g of groups) for (const a of g.agents) if (a !== "*" && a !== "" && t.includes(a)) best = Math.max(best, a.length);
  const pick = best >= 0 ? groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a) && a.length === best)) : groups.filter((g) => g.agents.includes("*"));
  return pick.flatMap((g) => g.rules);
}

function patternToRegExp(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

export interface RobotsVerdict { allowed: boolean; rule: string | null }

/** Пріоритет довшого правила (за довжиною шаблону); за рівності Allow виграє. Порожній Disallow = дозволено все. */
export function robotsVerdict(policy: RobotsPolicy, pathAndQuery: string, token = PRODUCT_TOKEN): RobotsVerdict {
  if (policy.fetch === "none") return { allowed: true, rule: null };
  if (policy.fetch === "unreachable") return { allowed: false, rule: "robots_unreachable" };
  let best: { len: number; allow: boolean; pattern: string } | null = null;
  for (const r of groupFor(policy.groups, token)) {
    if (r.pattern === "") continue;
    if (!patternToRegExp(r.pattern).test(pathAndQuery)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, pattern: r.pattern };
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.pattern}` };
}

export function robotsPolicyFromResponse(status: number | null, body: string | null): RobotsPolicy {
  if (status === null) return { groups: [], fetch: "unreachable" };
  if (status >= 200 && status < 300) return { groups: parseRobots((body ?? "").slice(0, 512 * 1024)), fetch: "ok" };
  if (status >= 500 || status === 429) return { groups: [], fetch: "unreachable" };
  return { groups: [], fetch: "none" };
}

// ------------------------------------------------------------------------------------------------ пауза + 1 сторінка на хост
export interface NavHit { host: string; url: string; ts: string; gap_ms: number | null }

/**
 * Один екземпляр на прогін. `run(url, fn)` серіалізує ВСЮ роботу зі сторінкою хоста (≤ 1 одночасно);
 * `wait(url)` викликається перед кожною навігацією й тримає ≥ minDelayMs від попереднього старту навігації до цього хоста.
 * Пауза < 1500 мс дозволена лише з `fixture: true` (явний прапорець).
 */
export class HostGate {
  private readonly last = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, number>();
  readonly hits: NavHit[] = [];
  maxConcurrent = 0;
  constructor(
    readonly minDelayMs: number = MIN_DELAY_MS,
    opts: { fixture?: boolean; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (minDelayMs < MIN_DELAY_MS && opts.fixture !== true) throw new Error(`HostGate: пауза ${minDelayMs} мс < ${MIN_DELAY_MS} мс дозволена лише з явним fixture:true (DEV-18)`);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  static hostOf(url: string): string {
    return new URL(url).host.toLowerCase();
  }
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = HostGate.hostOf(url);
    const prev = this.tails.get(host) ?? Promise.resolve();
    const mine = prev.then(async () => {
      const n = (this.active.get(host) ?? 0) + 1;
      this.active.set(host, n);
      this.maxConcurrent = Math.max(this.maxConcurrent, n);
      try {
        return await fn();
      } finally {
        this.active.set(host, (this.active.get(host) ?? 1) - 1);
      }
    });
    this.tails.set(host, mine.catch(() => undefined));
    return mine;
  }
  async wait(url: string): Promise<void> {
    const host = HostGate.hostOf(url);
    const last = this.last.get(host);
    let gap: number | null = null;
    if (last !== undefined) {
      const d = last + this.minDelayMs - this.now();
      if (d > 0) await this.sleep(d);
    }
    const t = this.now();
    if (last !== undefined) gap = t - last;
    this.last.set(host, t);
    this.hits.push({ host, url, ts: new Date(t).toISOString(), gap_ms: gap });
  }
  /** артефакт `host-hits.json` */
  report(): { min_delay_ms: number; max_concurrent_pages_per_host: number; per_host: Record<string, { navigations: number; min_gap_ms: number | null }>; hits: NavHit[] } {
    const per: Record<string, { navigations: number; min_gap_ms: number | null }> = {};
    for (const h of this.hits) {
      const e = (per[h.host] ??= { navigations: 0, min_gap_ms: null });
      e.navigations++;
      if (h.gap_ms !== null) e.min_gap_ms = e.min_gap_ms === null ? h.gap_ms : Math.min(e.min_gap_ms, h.gap_ms);
    }
    return { min_delay_ms: this.minDelayMs, max_concurrent_pages_per_host: this.maxConcurrent, per_host: per, hits: this.hits };
  }
}

// ------------------------------------------------------------------------------------------------ ≤ 5 аудитів на сайт за добу
type CounterFile = Record<string, { day: string; count: number }>;
export interface DailyVerdict { allowed: boolean; count: number; limit: number; day: string }

/** Персистентний лічильник (за замовчуванням `data/audit-counter.json`, `data/` у .gitignore). UTC-доба. Фікстура сюди не потрапляє. */
export class DailyAuditLimiter {
  constructor(
    readonly file: string,
    readonly limit: number = MAX_AUDITS_PER_DAY,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private read(): CounterFile {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as CounterFile) : {};
    } catch {
      return {};
    }
  }
  /** Перевіряє й, якщо дозволено, записує аудит. Відмова НЕ збільшує лічильник. */
  tryRecord(host: string): DailyVerdict {
    const day = this.now().toISOString().slice(0, 10);
    const all = this.read();
    const key = host.toLowerCase();
    const cur = all[key]?.day === day ? all[key]!.count : 0;
    if (cur >= this.limit) return { allowed: false, count: cur, limit: this.limit, day };
    all[key] = { day, count: cur + 1 };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, this.file);
    return { allowed: true, count: cur + 1, limit: this.limit, day };
  }
}
