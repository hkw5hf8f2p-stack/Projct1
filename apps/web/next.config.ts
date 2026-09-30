import path from "node:path";
import type { NextConfig } from "next";

/**
 * G0-5: слухаємо лише 127.0.0.1 (`next dev -H 127.0.0.1`, див. package.json).
 * SITELENS_SOURCE=fixture — ЯВНИЙ dev-прапорець: UI читає локальні JSON-фікстури через /api/dev/* (лише не-production).
 * Інакше UI ходить у реальний API (SITELENS_API_URL, за замовчуванням http://127.0.0.1:3001) через rewrites /api/* .
 */
const source = process.env["SITELENS_SOURCE"] === "fixture" ? "fixture" : "api";
const apiUrl = process.env["SITELENS_API_URL"] ?? "http://127.0.0.1:3001";

const config: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_SITELENS_SOURCE: source },
  transpilePackages: ["@sitelens/schemas"],
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  // дозволяє dev-серверу приймати запити з 127.0.0.1 (Next 16 блокує чужі origin для HMR)
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    if (source === "fixture") return [];
    return [{ source: "/api/:path((?!dev/).*)", destination: `${apiUrl}/api/:path` }];
  },
};
export default config;
