/**
 * Каталог шаблонів КОДУ для звіту (EN + UK). Жодної цифри в шаблоні: числа — лише плейсхолдери `{name}` на типізовані
 * поля звіту (DEV-58). Класи: опис детектора — OBSERVED/BENCHMARKED (як доказ), рекомендація за правилом — BENCHMARKED.
 * Ці тексти не від моделі, тож guard = not_applicable; лексичний сканер звіту (критерій S4 п.7) їх однаково бачить.
 */
import type { TemplatedText } from "@sitelens/schemas";

import type { Lang } from "./types.js";
type SC = TemplatedText["source_class"];
type Params = Record<string, { ptr: string; format: TemplatedText["params"][string]["format"] }>;
interface Pair { en: string; uk: string }

export function codeText(id: string, pair: Pair, lang: Lang, source_class: SC, params: Params = {}): TemplatedText {
  return { template: pair[lang], params, origin: "code", source_class, lang, template_id: id, guard: { status: "not_applicable", attempts: 0, rule_ids: [] } };
}

// ---------------------------------------------------------------- знахідки (за claim_kind)
export interface FindingTemplates { title: Pair; problem: Pair; why: Pair | null; change: Pair; validate: Pair }

const VALIDATE_AB: Pair = {
  en: "Run an A/B test of the changed page against the current one and compare add-to-cart clicks. Do not assume an effect before the test.",
  uk: "Запустіть A/B-тест зміненої сторінки проти поточної й порівняйте кліки «Додати в кошик». Не припускайте ефекту до тесту.",
};

export const FINDING_TEMPLATES: Record<string, FindingTemplates> = {
  below_fold: {
    title: { en: "The main purchase button is below the first screen", uk: "Основна кнопка покупки — нижче першого екрана" },
    problem: { en: "The add-to-cart button appears only after scrolling. Product pages affected: {page_count}.", uk: "Кнопку додавання в кошик видно лише після прокрутки. Сторінок товару з проблемою: {page_count}." },
    why: { en: "A visitor who is ready to buy has to search for the next step.", uk: "Відвідувач, готовий купити, мусить шукати наступний крок." },
    change: { en: "Place the add-to-cart button in the first screen, next to the price.", uk: "Розмістіть кнопку «Додати в кошик» у першому екрані, поруч із ціною." },
    validate: VALIDATE_AB,
  },
  not_in_first_viewport: {
    title: { en: "The price is not visible in the first screen", uk: "Ціни не видно в першому екрані" },
    problem: { en: "The first screen shows no price. Pages affected: {page_count}.", uk: "Перший екран не показує ціни. Сторінок із проблемою: {page_count}." },
    why: { en: "Without a visible price the visitor cannot judge the offer and has to look further.", uk: "Без видимої ціни відвідувач не може оцінити пропозицію й мусить шукати далі." },
    change: { en: "Show the price in the first screen, next to the product name.", uk: "Покажіть ціну в першому екрані, поруч із назвою товару." },
    validate: VALIDATE_AB,
  },
  deep_link_only: {
    title: { en: "Delivery information is not on the product page", uk: "Інформації про доставку немає на сторінці товару" },
    problem: { en: "The product page has no visible delivery text or link; delivery details are only deeper in the site. Product pages affected: {page_count}.", uk: "На сторінці товару немає видимого тексту чи посилання про доставку; умови доставки — лише глибше на сайті. Сторінок товару з проблемою: {page_count}." },
    why: { en: "Delivery cost and time are part of the purchase decision; hidden terms force a detour before buying.", uk: "Вартість і строк доставки — частина рішення про покупку; сховані умови змушують відволіктися перед покупкою." },
    change: { en: "Show delivery cost and time, or a direct link to them, next to the purchase button.", uk: "Покажіть вартість і строк доставки або пряме посилання на них поруч із кнопкою покупки." },
    validate: VALIDATE_AB,
  },
  horizontal_overflow: {
    title: { en: "The page scrolls sideways on mobile", uk: "Сторінка прокручується вбік на мобільному" },
    problem: { en: "On a mobile-width screen the page is wider than the screen. Pages affected: {page_count}.", uk: "На екрані мобільної ширини сторінка ширша за екран. Сторінок із проблемою: {page_count}." },
    why: { en: "Sideways scrolling hides content at the edge and makes the page harder to read on a phone.", uk: "Прокрутка вбік ховає вміст біля краю й ускладнює читання на телефоні." },
    change: { en: "Keep the wide element within the screen width, for example let a table scroll inside its own container.", uk: "Втримайте широкий елемент у межах екрана, наприклад дайте таблиці прокручуватися у власному контейнері." },
    validate: { en: "Re-run the capture at mobile width and check that the page is no wider than the screen.", uk: "Повторіть захоплення на мобільній ширині й перевірте, що сторінка не ширша за екран." },
  },
  oversized_image: {
    title: { en: "A very large image file on the page", uk: "Дуже великий файл зображення на сторінці" },
    problem: { en: "An image file is above the size threshold of the detector and is displayed much smaller than its natural size.", uk: "Файл зображення перевищує поріг розміру детектора й показується значно меншим за свій природний розмір." },
    why: { en: "Large files slow down loading, especially on mobile connections.", uk: "Великі файли сповільнюють завантаження, особливо на мобільному зв'язку." },
    change: { en: "Serve the image resized to its display size and in a compressed format.", uk: "Віддавайте зображення зменшеним до розміру показу й у стиснутому форматі." },
    validate: { en: "Re-run the capture and Lighthouse and compare the image size and load metrics.", uk: "Повторіть захоплення й Lighthouse і порівняйте розмір зображення та метрики завантаження." },
  },
};

export const AXE_TEMPLATES: FindingTemplates = {
  title: { en: "Automated accessibility check failed: {rule}", uk: "Автоматична перевірка доступності не пройдена: {rule}" },
  problem: { en: "axe-core flagged elements for this rule. Flagged elements across captures: {instances}. Pages affected: {page_count}.", uk: "axe-core позначив елементи за цим правилом. Позначених елементів у захопленнях: {instances}. Сторінок: {page_count}." },
  why: { en: "Elements without an accessible name or text alternative cannot be understood by screen-reader users.", uk: "Елементи без доступної назви чи текстової альтернативи незрозумілі користувачам екранних читачів." },
  change: { en: "Fix the flagged elements as described on the rule's help page linked in the evidence.", uk: "Виправте позначені елементи за описом на сторінці правила, посилання — у доказі." },
  validate: { en: "Re-run the automated check and test the page with a screen reader. Automated checks are not a complete WCAG audit.", uk: "Повторіть автоматичну перевірку й протестуйте сторінку екранним читачем. Автоматична перевірка не є повним аудитом WCAG." },
};

export const GENERIC_TEMPLATES: FindingTemplates = {
  title: { en: "Issue in category {category}", uk: "Проблема в категорії {category}" },
  problem: { en: "Evidence points to an issue in this category. Pages affected: {page_count}.", uk: "Докази вказують на проблему в цій категорії. Сторінок: {page_count}." },
  why: null,
  change: { en: "Review the evidence and address the issue it shows.", uk: "Перегляньте докази й усуньте показану ними проблему." },
  validate: VALIDATE_AB,
};

// ---------------------------------------------------------------- описи доказів (за detector_id)
export const EVIDENCE_TEMPLATES: Record<string, { pair: Pair; params: string[] }> = {
  cta_below_fold: {
    pair: { en: "Top edge of the main purchase button: {top_px} px; screen height: {vh} px.", uk: "Верхній край основної кнопки покупки: {top_px} px; висота екрана: {vh} px." },
    params: ["top_px", "vh"],
  },
  "price_first_viewport:none_on_page": {
    pair: { en: "No price in the first screen; no price was found on the page at all.", uk: "У першому екрані немає ціни; на сторінці ціну не знайдено взагалі." },
    params: [],
  },
  "price_first_viewport:below": {
    pair: { en: "First price at {first_price_y} px; screen height: {viewport_height} px.", uk: "Перша ціна на {first_price_y} px; висота екрана: {viewport_height} px." },
    params: ["first_price_y", "viewport_height"],
  },
  shipping_depth: {
    pair: { en: "No visible delivery text or link on the page (desktop and mobile checked); delivery information found at click depth {depth_clicks}.", uk: "На сторінці немає видимого тексту чи посилання про доставку (перевірено D і M); інформацію про доставку знайдено на глибині кліків {depth_clicks}." },
    params: ["depth_clicks"],
  },
  horizontal_overflow: {
    pair: { en: "Page width {scroll_width} px on a {viewport_width} px screen; overflow {overflow_px} px.", uk: "Ширина сторінки {scroll_width} px на екрані {viewport_width} px; надлишок {overflow_px} px." },
    params: ["scroll_width", "viewport_width", "overflow_px"],
  },
  oversized_image: {
    pair: { en: "Image file: {body_bytes} bytes (threshold {threshold_bytes}); natural {natural_w} × {natural_h} px, shown at {rendered_w} × {rendered_h} px.", uk: "Файл зображення: {body_bytes} байт (поріг {threshold_bytes}); природний розмір {natural_w} × {natural_h} px, показано {rendered_w} × {rendered_h} px." },
    params: ["body_bytes", "threshold_bytes", "natural_w", "natural_h", "rendered_w", "rendered_h"],
  },
  axe: {
    pair: { en: "axe-core rule {rule} (impact: {impact}) flagged this element.", uk: "Правило axe-core {rule} (вплив: {impact}) позначило цей елемент." },
    params: ["rule", "impact"],
  },
};

// ---------------------------------------------------------------- позитивні знахідки §29
export const POSITIVE_TEMPLATES: Record<string, { title: Pair; evidence: Pair; params: string[] }> = {
  price_in_first_viewport: {
    title: { en: "The price is visible in the first screen on product pages", uk: "Ціну видно в першому екрані на сторінках товару" },
    evidence: { en: "Price found in the first screen at {price_y} px; screen height: {viewport_height} px.", uk: "Ціну знайдено в першому екрані на {price_y} px; висота екрана: {viewport_height} px." },
    params: ["price_y", "viewport_height"],
  },
  cta_in_first_viewport: {
    title: { en: "The purchase button is in the first screen on product pages", uk: "Кнопка покупки — у першому екрані на сторінках товару" },
    evidence: { en: "Purchase button bottom edge at {button_bottom_px} px; screen height: {viewport_height} px.", uk: "Нижній край кнопки покупки на {button_bottom_px} px; висота екрана: {viewport_height} px." },
    params: ["button_bottom_px", "viewport_height"],
  },
  shipping_on_product_page: {
    title: { en: "Delivery information is shown on product pages", uk: "Інформацію про доставку показано на сторінках товару" },
    evidence: { en: "Visible text on the product page mentions delivery.", uk: "Видимий текст сторінки товару згадує доставку." },
    params: [],
  },
  no_horizontal_overflow: {
    title: { en: "No sideways scrolling on mobile", uk: "Немає прокрутки вбік на мобільному" },
    evidence: { en: "Page width {scroll_width} px fits the {viewport_width} px screen.", uk: "Ширина сторінки {scroll_width} px вміщується в екран {viewport_width} px." },
    params: ["scroll_width", "viewport_width"],
  },
  images_have_alt: {
    title: { en: "Content images have text alternatives", uk: "Змістові зображення мають текстову альтернативу" },
    evidence: { en: "Images with an alt attribute: {with_alt} of {total} on this capture.", uk: "Зображень з атрибутом alt: {with_alt} з {total} у цьому захопленні." },
    params: ["with_alt", "total"],
  },
};

export const BANNER_TEXT: Record<"replay_not_live" | "example_fixture" | "budget_limited" | "stage_failed" | "stage_skipped", Pair> = {
  replay_not_live: { en: "Synthetic results are replayed recordings, not a live model run.", uk: "Синтетичні результати — відтворені записи, а не прогін живої моделі." },
  example_fixture: { en: "Example report for interface development. It is not the result of an audit.", uk: "Приклад звіту для розробки інтерфейсу. Це не результат аудиту." },
  budget_limited: { en: "This stage stopped at the token budget; results are partial.", uk: "Етап зупинено на бюджеті токенів; результати часткові." },
  stage_failed: { en: "This stage failed; its results are missing from the report.", uk: "Етап завершився помилкою; його результатів у звіті немає." },
  stage_skipped: { en: "This stage was skipped.", uk: "Етап пропущено." },
};
