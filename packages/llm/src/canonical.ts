import { createHash } from "node:crypto";

/** Канонічний JSON: ключі об'єктів відсортовано, undefined відкинуто. Основа ключів кешу (E5) і lock-файлу промптів. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** stableId (SCORING_SPEC §9.2): sha256(canonicalJSON(x)) */
export const stableId = (v: unknown): string => sha256(canonicalJson(v));
