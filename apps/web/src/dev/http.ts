import { NextResponse } from "next/server";
import { isFixtureMode } from "./fixtures";

export const notFixtureMode = () => NextResponse.json({ error: { class: "not_found", message: "Не знайдено" } }, { status: 404 });
export const apiError = (status: number, cls: string, message: string) => NextResponse.json({ error: { class: cls, message } }, { status });
export const guardFixture = (): NextResponse | null => (isFixtureMode() ? null : notFixtureMode());
export const FIXTURE_TOKEN = "fixture-token";
export const tokenOk = (req: Request): boolean => (req.headers.get("authorization") ?? "") === `Bearer ${FIXTURE_TOKEN}`;
