/**
 * Рендер тексту звіту. UI НЕ формулює текст: шаблон із контракту + типізовані поля через `renderText` пакета schemas
 * (той самий код, що й перевірка контракту). Порушення контракту → `null` (UI покаже «текст недоступний», не сирий шаблон).
 */
import { renderText, type TemplatedTextLike } from "@sitelens/schemas/src/report-text.ts";
import type { Report, TemplatedText } from "./types";

const cache = new WeakMap<object, string | null>();

export function renderClaim(text: TemplatedText, report: Report): string | null {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out: string | null;
  try {
    out = renderText(text as unknown as TemplatedTextLike, report, text.lang);
  } catch {
    out = null;
  }
  cache.set(text, out);
  return out;
}

/** `n of m synthetic …` у мові звіту — через formatParam контракту (n_of_m), а не власним складанням рядка */
export { formatParam } from "@sitelens/schemas/src/report-text.ts";
