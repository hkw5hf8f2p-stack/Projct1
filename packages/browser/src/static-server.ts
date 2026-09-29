import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/** Мінімальний статичний сервер фікстур на 127.0.0.1 (лише GET/HEAD; інше → 405 і запис у лог). */
export async function serveDir(dir: string): Promise<{ origin: string; requests: Array<{ method: string; url: string }>; close: () => Promise<void> }> {
  const requests: Array<{ method: string; url: string }> = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method ?? "?", url: req.url ?? "" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
