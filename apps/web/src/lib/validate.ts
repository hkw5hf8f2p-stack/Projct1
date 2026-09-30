import type { Key } from "./messages";

/** Клієнтська перевірка лише форми вводу; чи дозволена адреса (SSRF, §49) вирішує API — його відповідь показуємо як є. */
export function validateUrlInput(raw: string): Key | null {
  const v = raw.trim();
  if (v.length === 0) return "landing.err.empty";
  if (v.length > 2048) return "landing.err.too_long";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme && !/^https?$/i.test(scheme[1] as string) && !/^[a-z0-9.-]+:\d+/i.test(v)) return "landing.err.scheme";
  if (/\s/.test(v)) return "landing.err.invalid";
  const withScheme = scheme && /^https?$/i.test(scheme[1] as string) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || (!u.hostname.includes(".") && !u.hostname.includes(":") && u.hostname !== "localhost")) return "landing.err.invalid";
  } catch {
    return "landing.err.invalid";
  }
  return null;
}

