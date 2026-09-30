/**
 * Адаптер SPEC §22 SyntheticSession → SessionObs. Мітка `severity` агента і вільний текст friction у скоринг НЕ
 * потрапляють (C2: числа ставить код) — лише закрита класифікація (category, claim_kind) і сторінка.
 */
import { buildFindingKey, type SyntheticSession } from "@sitelens/schemas";
import type { SessionObs } from "./score.js";

type Friction = SyntheticSession["frictions"][number];

export function sessionObs(
  s: SyntheticSession,
  opts: {
    pagesSeen: readonly string[];
    /** закрита класифікація friction (LLM обирає зі списку, інакше `general`) */
    claimKindOf?: (f: Friction) => string;
    /** шлях → page_group (шаблонні сторінки → тип, одиничні → шлях) */
    pageGroupOf: (path: string) => string;
  },
): SessionObs {
  const keys = s.frictions.map((f) =>
    buildFindingKey({ category: f.category, page_group: opts.pageGroupOf(new URL(f.page_url, "http://x.invalid").pathname), claim_kind: opts.claimKindOf?.(f) ?? "general" }),
  );
  return {
    session_id: s.session_id,
    lens_id: s.lens_id,
    task_id: s.task_id,
    level: s.level,
    success: s.success,
    pages_seen: [...new Set(opts.pagesSeen)].sort(),
    reported_keys: [...new Set(keys)].sort(),
    last_friction_key: keys.length ? (keys[keys.length - 1] as string) : null,
  };
}
