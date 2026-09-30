import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PageArtifactCapture } from "@sitelens/schemas";
import { sha256 } from "./canonical.js";
import { detectLang, norm } from "./guards/text.js";
import type { ImagePart } from "./types.js";

/** Вхід етапів S3 — артефакти захоплення (pages.json + скриншоти), не браузер */
export interface PageInput {
  id: string;
  url: string;
  page_type: string;
  title: string;
  meta_description: string;
  headings: string[];
  visible_text: string;
  link_texts: string[];
  /** перше вікно (D4: кроп, не full-page); байти читаються адаптером у момент відправки */
  image: ImagePart | null;
}

export function loadPagesFromArtifacts(dir: string): PageInput[] {
  const raw = JSON.parse(readFileSync(path.join(dir, "pages.json"), "utf8")) as unknown[];
  return raw.map((r) => {
    const p = PageArtifactCapture.parse(r);
    const md = p.metadata_json as { meta_description?: string; headings?: Array<{ text: string }> };
    const imgRel = `pages/${p.id}/1440x1000/viewport.png`;
    const imgAbs = path.join(dir, imgRel);
    const image: ImagePart | null = existsSync(imgAbs)
      ? { type: "image", media_type: "image/png", sha256: sha256(readFileSync(imgAbs)), path: imgAbs, label: `${p.id} first viewport` }
      : null;
    return {
      id: p.id, url: p.url, page_type: p.page_type, title: p.title ?? "", meta_description: md.meta_description ?? "",
      headings: (md.headings ?? []).map((h) => h.text), visible_text: p.visible_text ?? "",
      link_texts: p.links_json.filter((l) => l.visible).map((l) => l.text).filter(Boolean), image,
    };
  });
}

const TYPE_ORDER: Record<string, number> = { homepage: 0, category: 1, product: 2, info_shipping: 3, about: 4, faq: 5, cart: 6, checkout: 7, other: 8, unknown: 9 };
export const MAX_PROFILE_PAGES = 8;
export const MAX_PROFILE_IMAGES = 3;
export const MAX_TEXT_PER_PAGE = 2500;

/** До LLM іде обмежений набір (SPEC §51): за типом сторінки, потім id; продукти — не більше 2 */
export function selectPagesForProfile(pages: readonly PageInput[]): PageInput[] {
  const sorted = [...pages].sort((a, b) => (TYPE_ORDER[a.page_type] ?? 9) - (TYPE_ORDER[b.page_type] ?? 9) || a.id.localeCompare(b.id));
  const out: PageInput[] = [];
  let products = 0;
  for (const p of sorted) {
    if (p.page_type === "product" && ++products > 2) continue;
    out.push(p);
    if (out.length >= MAX_PROFILE_PAGES) break;
  }
  return out;
}

/** Ізоляція вмісту (G0-12): делімітери з nonce, розділювачі всередині тексту нейтралізуються */
export const neutralize = (s: string): string => s.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››");

export function pageNonce(pages: readonly PageInput[]): string {
  return sha256(pages.map((p) => `${p.id}\n${p.visible_text}`).join("\n\u0000")).slice(0, 12);
}

export function wrapPageData(pages: readonly PageInput[]): string {
  const nonce = pageNonce(pages);
  return pages.map((p) => [
    `<<<PAGE_DATA nonce=${nonce} page_id=${p.id} type=${p.page_type} url=${neutralize(p.url)}>>>`,
    `title: ${neutralize(p.title)}`,
    `meta_description: ${neutralize(p.meta_description)}`,
    `headings: ${neutralize(p.headings.join(" | "))}`,
    `visible_text:\n${neutralize(p.visible_text.slice(0, MAX_TEXT_PER_PAGE))}`,
    `<<<END_PAGE_DATA nonce=${nonce}>>>`,
  ].join("\n")).join("\n");
}

export const wrapDerivedData = (json: string): string => `<<<DERIVED_DATA>>>\n${neutralize(json)}\n<<<END_DERIVED_DATA>>>`;

/** кількість символів, які модель бачила по сторінці (корпус для звірки цитат і відсотків) */
export const pageCorpus = (p: PageInput): string => norm([p.title, p.meta_description, p.headings.join(" "), p.visible_text.slice(0, MAX_TEXT_PER_PAGE)].join("\n"));

/** мова аудиту за замовчуванням = мова сайту (D2, OQ-4); явне значення має пріоритет */
export function resolveAuditLanguage(requested: string | undefined, pages: readonly PageInput[]): "uk" | "en" {
  if (requested === "uk" || requested === "en") return requested;
  const l = detectLang(pages.map((p) => p.visible_text).join(" "));
  return l === "en" ? "en" : "uk"; // ru/невідомо → uk за замовчуванням (R-19); власник може задати явно
}
