import { NextResponse } from "next/server";
import { fixtureSpec, reportVariant } from "@/dev/fixtures";
import { apiError, guardFixture, tokenOk } from "@/dev/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = guardFixture();
  if (g) return g;
  const { id } = await ctx.params;
  const spec = fixtureSpec(id);
  if (!spec) return apiError(404, "not_found", "Аудит не знайдено");
  if (spec.locked && !tokenOk(req)) return apiError(401, "unauthorized", "Потрібен ACCESS_TOKEN (Authorization: Bearer …)");
  if (spec.status === "queued" || spec.status === "running" || spec.status === "running_partial" || spec.status === "failed") return apiError(409, "not_ready", "Звіт ще не готовий");
  if (spec.reportDelayMs) await new Promise((r) => setTimeout(r, spec.reportDelayMs));
  if (spec.reportHttp === 500) return apiError(500, "internal", "Внутрішня помилка сервера");
  if (spec.reportHttp === 404) return apiError(404, "not_found", "Звіт не знайдено");
  if (spec.badSchema) return NextResponse.json({ schema_version: "other/v9" });
  const r = reportVariant(spec.report ?? "completed");
  return r ? NextResponse.json(r) : apiError(404, "not_found", "Звіт не знайдено");
}
