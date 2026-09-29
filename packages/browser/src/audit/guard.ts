/**
 * Шар 2 захисту (DEV-12, G0-11): у контексті блокується будь-який не-GET/HEAD запит до будь-якого origin,
 * кожен блок залоговано. Шар 1 (egress-проксі, net/) і secure-launch — власність sl-security.
 * Це мінімальна локальна реалізація для захоплення; якщо sl-security додасть спільний guard — замінити викликом.
 */
import type { BrowserContext } from "playwright";
import type { NetworkRow } from "./types.js";

export interface BlockedRequest { method: string; url: string; resource_type: string }

export async function installMethodGuard(context: BrowserContext, sink: BlockedRequest[]): Promise<void> {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    if (method === "GET" || method === "HEAD") {
      await route.fallback(); // далі — інші шари (secure-launch), а наприкінці мережа
      return;
    }
    sink.push({ method, url: req.url(), resource_type: req.resourceType() });
    await route.abort("blockedbyclient");
  });
}

export const blockedRow = (b: BlockedRequest): NetworkRow => ({
  method: b.method,
  url: b.url,
  resource_type: b.resource_type,
  status: null,
  content_type: null,
  body_bytes: null,
  blocked: true,
  failure: "blocked_by_method_guard",
});
