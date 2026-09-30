import { NextResponse } from "next/server";
import { fixtureSpec, statusView } from "@/dev/fixtures";
import { apiError, guardFixture, tokenOk } from "@/dev/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = guardFixture();
  if (g) return g;
  const { id } = await ctx.params;
  const spec = fixtureSpec(id);
  if (!spec) return apiError(404, "not_found", "Аудит не знайдено");
  if (spec.locked && !tokenOk(req)) return apiError(401, "unauthorized", "Потрібен ACCESS_TOKEN (Authorization: Bearer …)");
  return NextResponse.json(statusView(spec, spec.report ?? null));
}
