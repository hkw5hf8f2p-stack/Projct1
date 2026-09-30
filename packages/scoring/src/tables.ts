/**
 * Таблиці SCORING_SPEC (scoring-v1) як константи коду з тими самими ID. Зміна значення = нова версія scoring-vN
 * і запис у SCORING_SPEC. LLM жодного числа тут не ставить.
 */
import { PRIORITY_BASE_WEIGHTS, type CATEGORIES, type FUNNEL_STAGES, type PAGE_TYPES } from "@sitelens/schemas";

/**
 * scoring-v2 (DEV-76): числа знахідок (formula `scoring-v1/redistributed`, таблиці, кеп DEV-60) НЕ змінено; змінено лише
 * порядок звіту — смуга впевненості (VERIFIED над гіпотезами) іде ПЕРЕД priority (SCORING_SPEC §6.5).
 */
export const SCORING_VERSION = "scoring-v2" as const;
export const EPS = 1e-9;

type Category = (typeof CATEGORIES)[number];
type FunnelStage = (typeof FUNNEL_STAGES)[number];
type PageType = (typeof PAGE_TYPES)[number];

/** §6.1 W — єдине джерело в @sitelens/schemas (контракт звіту перевіряє ті самі ваги) */
export const W = PRIORITY_BASE_WEIGHTS;

/** §1.2 рівні сили */
export const ET_STRENGTH = { "ET-DET": 1.0, "ET-BRW": 0.9, "ET-SYN-M": 0.7, "ET-SYN-1": 0.4, "ET-INF": 0.3, "ET-INC": 0.3 } as const;

/** §3.1 SEV-BASE */
export const SEV_BASE: Record<Category, number> = {
  checkout: 0.85, pricing: 0.8, cta: 0.75, value_proposition: 0.75, shipping: 0.7, trust: 0.7, product_selection: 0.65,
  mobile_usability: 0.65, navigation: 0.6, missing_information: 0.6, accessibility: 0.6, comparison: 0.55, performance: 0.55,
  terminology: 0.45, visual_hierarchy: 0.45, content_overload: 0.35, other: 0.3,
};

/** §3.2 перевизначення */
export const AXE_IMPACT_BASE = { critical: 0.7, serious: 0.6, moderate: 0.4, minor: 0.2 } as const;
export const LH_BASE = { severe: 0.65, moderate: 0.45, opportunities_only: 0.3 } as const;
/** LCP > 4.0 s або TBT > 600 ms → severe; 2.5 < LCP ≤ 4.0 або 200 < TBT ≤ 600 → moderate */
export const LH_THRESHOLDS = { lcp_severe_ms: 4000, lcp_moderate_ms: 2500, tbt_severe_ms: 600, tbt_moderate_ms: 200 } as const;
/** DEV-20: тіло зображення ≥ 512 000 байт → max(поточна, 0.45) */
export const NETWORK_IMAGE_BYTES = 512_000;
export const NETWORK_FLOOR = 0.45;

/** §3.3 модифікатори */
export const MOD = { "MOD-PAGE-PRIMARY": 0.05, "MOD-PAGE-SECONDARY": 0, "MOD-PAGE-PERIPHERAL": -0.1, "MOD-BLOCKER": 0.1 } as const;
export type ModId = keyof typeof MOD;

/**
 * Клас сторінки для модифікатора — на ФАКТИЧНИХ типах класифікатора S1a (DEV-39 → DEV-59):
 * info_shipping ≡ shipping, checkout ≡ cart (PRIMARY); other/unknown ≡ other (PERIPHERAL).
 */
export const PAGE_MOD: Record<PageType, "MOD-PAGE-PRIMARY" | "MOD-PAGE-SECONDARY" | "MOD-PAGE-PERIPHERAL"> = {
  homepage: "MOD-PAGE-PRIMARY", category: "MOD-PAGE-PRIMARY", product: "MOD-PAGE-PRIMARY", cart: "MOD-PAGE-PRIMARY",
  checkout: "MOD-PAGE-PRIMARY", info_shipping: "MOD-PAGE-PRIMARY",
  about: "MOD-PAGE-SECONDARY", faq: "MOD-PAGE-SECONDARY",
  other: "MOD-PAGE-PERIPHERAL", unknown: "MOD-PAGE-PERIPHERAL",
};

/** §4.1 FUN-STAGE */
export const FUN_STAGE: Record<FunnelStage, number> = {
  landing: 0.3, understand_offering: 0.45, browse: 0.55, select: 0.7, evaluate_product: 0.8, price_shipping_confidence: 0.9, cart: 1.0,
};

/** §4.2 канонічний етап категорії */
export const CATEGORY_STAGE: Partial<Record<Category, FunnelStage>> = {
  pricing: "price_shipping_confidence", shipping: "price_shipping_confidence", checkout: "cart", product_selection: "select", comparison: "select",
};

/** §4.2 PAGE_STAGE на типах S1a (DEV-59): info_shipping → price_shipping_confidence, checkout → cart, unknown → як other */
export const PAGE_STAGE: Record<PageType, FunnelStage> = {
  homepage: "landing", about: "understand_offering", faq: "understand_offering", other: "understand_offering", unknown: "understand_offering",
  category: "browse", product: "evaluate_product", info_shipping: "price_shipping_confidence", cart: "cart", checkout: "cart",
};

export const CONFIDENCE_RANK = { VERIFIED: 3, STRONG_HYPOTHESIS: 2, HYPOTHESIS: 1 } as const;

/**
 * §6.5 смуга ранжування (DEV-76, scoring-v2): перевірений факт (VERIFIED) — смуга 1, гіпотези (STRONG і HYPOTHESIS) — 0.
 * Лексикографічно першою: без калібрування немає P(гіпотеза істинна), тож будь-який обмін «severity гіпотези проти
 * впевненості факту» був би некаліброваним числом. Всередині смуги — priority за формулою. Єдине джерело — @sitelens/schemas.
 */
export { RANK_BAND } from "@sitelens/schemas";

/** §2: claim_kind про сприйняття — виняток із правила суперечності (детектор перевіряє лише наявність) */
export const PERCEPTUAL_CLAIM_KINDS: ReadonlySet<string> = new Set(["noticed_but_unclear", "visible_but_not_salient"]);
