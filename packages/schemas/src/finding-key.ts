/**
 * finding_key (DEV-7, SCORING_SPEC §5; формат — DEV-38).
 * Канонічний вигляд, який реально видає S1a: `category|page_group|claim_kind[|component]`.
 * Етап воронки (`stage`) — окреме поле Finding, а не сегмент ключа: він виводиться детерміновано
 * з category/page_type (SCORING_SPEC §4.2), тож у ключі був би надлишковим.
 * Нормалізація: без пробілів по краях, без символу `|` усередині сегментів.
 */
import { CATEGORIES, isClaimKindFor } from "./enums.js";

export interface FindingKeyParts {
  category: (typeof CATEGORIES)[number];
  /** `product`/`category` для шаблонних сторінок, нормалізований шлях (`/`, `/shipping`) для одиничних, `*` для наскрізних (axe у шапці) */
  page_group: string;
  claim_kind: string;
  /** axe: сигнатура компонента (`header/button`) */
  component?: string | undefined;
}

const seg = (s: string, what: string): string => {
  const t = s.trim();
  if (t === "" || t.includes("|")) throw new Error(`finding_key: некоректний сегмент ${what}: ${JSON.stringify(s)}`);
  return t;
};

export function buildFindingKey(p: FindingKeyParts): string {
  if (!isClaimKindFor(p.category, p.claim_kind)) throw new Error(`finding_key: claim_kind ${p.claim_kind} не належить категорії ${p.category}`);
  const parts = [p.category, seg(p.page_group, "page_group"), seg(p.claim_kind, "claim_kind")];
  if (p.component !== undefined) parts.push(seg(p.component, "component"));
  return parts.join("|");
}

/** повертає розібрані частини або null, якщо ключ не канонічний */
export function parseFindingKey(key: string): FindingKeyParts | null {
  const s = key.split("|");
  if (s.length < 3 || s.length > 4 || s.some((x) => x.trim() === "" || x !== x.trim())) return null;
  const [category, page_group, claim_kind, component] = s as [string, string, string, string | undefined];
  if (!(CATEGORIES as readonly string[]).includes(category)) return null;
  const c = category as FindingKeyParts["category"];
  if (!isClaimKindFor(c, claim_kind)) return null;
  return { category: c, page_group, claim_kind, ...(component !== undefined ? { component } : {}) };
}

import { createHash } from "node:crypto";
/** детермінований id знахідки в межах аудиту (для PK БД; артефакти S1a ключуються finding_key) */
export const findingId = (finding_key: string): string => "fnd_" + createHash("sha256").update(finding_key).digest("hex").slice(0, 12);
