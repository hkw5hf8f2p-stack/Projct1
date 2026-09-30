/**
 * Мережевий контроль для тестів (критерій 1): журнал усіх DNS-резолвів і TCP-з'єднань процесу + обгортка fetch.
 * Перевірка йде за журналом, а не за прапорцем «мережа вимкнена». Предикат `providerHits` вміє впасти:
 * тест із навмисним «живим» викликом до мок-сервера (api.anthropic.com → 127.0.0.1) має його спрацювати.
 */
import dns from "node:dns";
import net from "node:net";

export const PROVIDER_HOSTS = ["api.anthropic.com", "api.openai.com"] as const;

export interface NetEvent { kind: "dns" | "connect" | "fetch"; host: string; port?: number }

export class NetGuard {
  readonly events: NetEvent[] = [];
  private restore: Array<() => void> = [];
  /** відображення host → IP лише для тестового мок-сервера (щоб довести, що предикат бачить «провайдерський» host) */
  constructor(private readonly hostMap: Record<string, string> = {}) {}

  install(): this {
    const origLookup = dns.lookup;
    const map = this.hostMap;
    const ev = this.events;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = function (hostname: string, ...rest: any[]) {
      ev.push({ kind: "dns", host: hostname });
      const mapped = map[hostname];
      if (mapped) {
        const cb = rest[rest.length - 1] as (...a: unknown[]) => void;
        const opts = rest.length > 1 ? rest[0] : undefined;
        if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) return process.nextTick(cb, null, [{ address: mapped, family: 4 }]);
        return process.nextTick(cb, null, mapped, 4);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origLookup as any).call(dns, hostname, ...rest);
    };
    this.restore.push(() => { dns.lookup = origLookup; });
    const origConnect = net.Socket.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
      const a = args[0];
      if (a && typeof a === "object") ev.push({ kind: "connect", host: String(a.host ?? a.path ?? "?"), port: a.port });
      else if (typeof a === "number") ev.push({ kind: "connect", host: String(args[1] ?? "localhost"), port: a });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origConnect as any).apply(this, args);
    };
    this.restore.push(() => { net.Socket.prototype.connect = origConnect; });
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      ev.push({ kind: "fetch", host: u.hostname, port: Number(u.port) || undefined });
      return origFetch(input, init);
    }) as typeof fetch;
    this.restore.push(() => { globalThis.fetch = origFetch; });
    return this;
  }
  uninstall(): void { for (const r of this.restore.reverse()) r(); this.restore = []; }
  /** усі не-loopback звернення (для строгого режиму) */
  nonLoopback(): NetEvent[] { return this.events.filter((e) => !/^(127\.|localhost$|::1$|\[::1\]$|\?$)/.test(e.host)); }
  providerHits(): NetEvent[] { return this.events.filter((e) => (PROVIDER_HOSTS as readonly string[]).includes(e.host)); }
}

/** Предикат критерію 1: `true` = чисто (0 звернень до провайдерів) */
export const noProviderTraffic = (g: NetGuard): boolean => g.providerHits().length === 0;
