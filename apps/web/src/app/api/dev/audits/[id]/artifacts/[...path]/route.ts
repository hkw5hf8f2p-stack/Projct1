import fs from "node:fs";
import path from "node:path";
import { fixtureSpec, artifactRoot } from "@/dev/fixtures";
import { apiError, guardFixture } from "@/dev/http";

export const dynamic = "force-dynamic";
const TYPES: Record<string, string> = { ".png": "image/png", ".json": "application/json" };

/** dev: статичний віддавач артефактів з planning/qa/artifacts (лише png/json, без виходу за корінь) */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; path: string[] }> }) {
  const g = guardFixture();
  if (g) return g;
  const { id, path: parts } = await ctx.params;
  const spec = fixtureSpec(id);
  if (!spec) return apiError(404, "not_found", "Аудит не знайдено");
  if (spec.artifactsDeleted) return apiError(410, "gone", "Артефакти видалено");
  const root = artifactRoot(spec);
  const file = path.resolve(root, ...parts.map((p) => decodeURIComponent(p)));
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(root + path.sep) || !type) return apiError(404, "not_found", "Не знайдено");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return apiError(404, "not_found", "Не знайдено");
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
}
