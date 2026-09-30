import { siteProfileV1 } from "../../prompts/site-profile-v1.js";
import { findInjectionEcho, findInventedNumbers, findUnknownRequired, findWrongLanguage, type Issue, detectLang, norm } from "../guards/text.js";
import { MAX_PROFILE_IMAGES, pageCorpus, selectPagesForProfile, wrapPageData, type PageInput } from "../page-input.js";
import { SiteProfileLlm, type SiteProfileCore } from "../schemas.js";
import { buildRequest, LANG_NAME } from "./prompt-util.js";
import { done, guardStage, type StageContext, type StageResult } from "./types.js";

export interface SiteProfileOutput { profile: SiteProfileCore; evidence: SiteProfileLlm["evidence"]; prompt_id: string; pages_used: string[] }

const REQUIRED_EVIDENCE = ["business_type", "offering_summary", "primary_conversion_goal"] as const;
const LIST_EVIDENCE = ["primary_products", "key_value_propositions", "trust_signals"] as const;

/** Усі текстові значення профілю (для перевірок чисел/ін'єкцій) */
export function profileStrings(p: SiteProfileCore): string[] {
  return Object.entries(p).flatMap(([, v]) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));
}
const proseOf = (p: SiteProfileCore) => [p.offering_summary, ...p.key_value_propositions, ...p.purchase_objections, ...p.confidence_notes].filter((s) => s.length > 0);

/** Семантичні правила відповіді SiteProfile — код, а не модель, вирішує, що вигадка (§34) */
export function validateProfile(v: SiteProfileLlm, pages: readonly PageInput[], lang: "uk" | "en"): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const { evidence, ...profile } = v;
  const corpusAll = pages.map((p) => pageCorpus(p)).join("\n");
  out.push(...findUnknownRequired({ business_type: profile.business_type, offering_summary: profile.offering_summary, primary_conversion_goal: profile.primary_conversion_goal, site_language: profile.site_language }));
  for (const e of evidence) {
    const p = byId.get(e.page_id);
    if (!p) { out.push(`dangling_reference: page_id «${e.page_id}» немає серед наданих сторінок`); continue; }
    if (!pageCorpus(p).includes(norm(e.quote))) out.push(`dangling_reference: цитати «${e.quote.slice(0, 60)}» немає на сторінці ${e.page_id}`);
  }
  for (const f of REQUIRED_EVIDENCE) if (!evidence.some((e) => e.field === f)) out.push(`missing_evidence: для ${f} немає жодного посилання на доказ`);
  for (const f of LIST_EVIDENCE) if (profile[f].length > 0 && !evidence.some((e) => e.field === f)) out.push(`missing_evidence: для ${f} немає посилання на доказ`);
  out.push(...findInventedNumbers(profileStrings(profile), corpusAll));
  out.push(...findInjectionEcho(profileStrings(profile)));
  out.push(...findWrongLanguage(proseOf(profile), lang));
  const detected = detectLang(pages.map((p) => p.visible_text).join(" "));
  if (detected !== "unknown" && profile.site_language.toLowerCase().slice(0, 2) !== detected) out.push(`wrong_language: site_language=${profile.site_language}, текст сторінок — ${detected}`);
  return out;
}

export async function buildSiteProfile(ctx: StageContext, input: { pages: readonly PageInput[] }): Promise<StageResult<SiteProfileOutput>> {
  return guardStage("site_profile", siteProfileV1.id, ctx, async () => {
    const pages = selectPagesForProfile(input.pages);
    const images = pages.filter((p) => p.image).slice(0, MAX_PROFILE_IMAGES).map((p) => p.image!);
    const req = buildRequest({
      stage: "site_profile", prompt: siteProfileV1, max_tokens: 4000, images,
      vars: { LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], PAGE_DATA: wrapPageData(pages) },
      logical: { page_url: pages[0]?.url, step: 0 },
    });
    const r = await ctx.client.call(req, SiteProfileLlm, (v) => validateProfile(v, pages, ctx.language));
    const { evidence, ...profile } = r.value;
    return done("site_profile", siteProfileV1.id, { profile, evidence, prompt_id: siteProfileV1.id, pages_used: pages.map((p) => p.id) }, r.calls);
  });
}
