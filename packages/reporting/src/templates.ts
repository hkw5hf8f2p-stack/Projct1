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

// DEV-97: лабораторна метрика Lighthouse гірша за поріг «добре» (знахідка performance, VERIFIED за C3)
FINDING_TEMPLATES["lighthouse_metric_poor"] = {
  title: { en: "Slow loading in the Lighthouse lab test", uk: "Повільне завантаження в лабораторному тесті Lighthouse" },
  problem: { en: "Lighthouse measured a loading metric (largest content paint or blocking time) worse than the published “good” threshold; the measured values are in the evidence. Pages affected: {page_count}.", uk: "Lighthouse виміряв метрику завантаження (відмальовування найбільшого елемента або час блокування) гіршою за опублікований поріг «добре»; виміряні значення — у доказах. Сторінок: {page_count}." },
  why: { en: "The main content appears late, so a visitor waits before seeing the offer, especially on slower devices.", uk: "Основний вміст з'являється пізно, тож відвідувач чекає, перш ніж побачить пропозицію, особливо на повільніших пристроях." },
  change: { en: "Open the Lighthouse report of this page and fix the largest opportunities first: optimise and preload the hero image, defer non-critical scripts.", uk: "Відкрийте звіт Lighthouse цієї сторінки й почніть із найбільших можливостей: оптимізуйте й попередньо завантажте головне зображення, відкладіть некритичні скрипти." },
  validate: { en: "Re-run Lighthouse on the same page and form factor and compare the metric with the threshold; lab results vary between runs.", uk: "Повторіть Lighthouse на тій самій сторінці й пристрої та порівняйте метрику з порогом; лабораторні результати коливаються між прогонами." },
};

export const AXE_TEMPLATES: FindingTemplates = {
  title: { en: "Automated accessibility check failed: {rule}", uk: "Автоматична перевірка доступності не пройдена: {rule}" },
  problem: { en: "axe-core flagged elements for this rule. Flagged elements across captures: {instances}. Pages affected: {page_count}.", uk: "axe-core позначив елементи за цим правилом. Позначених елементів у захопленнях: {instances}. Сторінок: {page_count}." },
  why: { en: "Elements without an accessible name or text alternative cannot be understood by screen-reader users.", uk: "Елементи без доступної назви чи текстової альтернативи незрозумілі користувачам екранних читачів." },
  change: { en: "Fix the flagged elements as described on the rule's help page linked in the evidence.", uk: "Виправте позначені елементи за описом на сторінці правила, посилання — у доказі." },
  validate: { en: "Re-run the automated check and test the page with a screen reader. Automated checks are not a complete WCAG audit.", uk: "Повторіть автоматичну перевірку й протестуйте сторінку екранним читачем. Автоматична перевірка не є повним аудитом WCAG." },
};

/** DEV-98: зрозуміла назва й «чому» для поширених правил axe (замість «не пройдена: axe:color-contrast»); решта правил — AXE_TEMPLATES */
export const AXE_RULE_TEXT: Record<string, { title: Pair; why: Pair }> = {
  "color-contrast": { title: { en: "Low text contrast: some text is hard to read", uk: "Низький контраст тексту: частину тексту важко прочитати" }, why: { en: "Low-contrast text is hard to read for people with weaker eyesight and on a phone in sunlight.", uk: "Тексти з низьким контрастом важко читати людям зі слабшим зором і на телефоні при яскравому світлі." } },
  "image-alt": { title: { en: "Images without a text alternative", uk: "Зображення без текстової альтернативи" }, why: { en: "Screen-reader users do not learn what the image shows.", uk: "Користувачі екранних читачів не дізнаються, що показано на зображенні." } },
  "button-name": { title: { en: "Buttons without an accessible name", uk: "Кнопки без доступної назви" }, why: { en: "A screen reader announces such a button without saying what it does.", uk: "Екранний читач оголошує таку кнопку, не кажучи, що вона робить." } },
  "link-name": { title: { en: "Links without an accessible name", uk: "Посилання без доступної назви" }, why: { en: "A screen reader cannot tell where such a link leads.", uk: "Екранний читач не може сказати, куди веде таке посилання." } },
  "label": { title: { en: "Form fields without a label", uk: "Поля форми без підпису" }, why: { en: "Without a label it is unclear what to enter, especially with a screen reader.", uk: "Без підпису незрозуміло, що вводити, особливо з екранним читачем." } },
  "aria-prohibited-attr": { title: { en: "ARIA attributes used where they are not allowed", uk: "Атрибути ARIA там, де вони заборонені" }, why: { en: "Assistive technology may ignore or misread such elements.", uk: "Допоміжні технології можуть проігнорувати чи хибно прочитати такі елементи." } },
  "heading-order": { title: { en: "Headings skip levels", uk: "Заголовки пропускають рівні" }, why: { en: "A broken heading structure makes page navigation harder for screen-reader users.", uk: "Порушена структура заголовків ускладнює навігацію сторінкою з екранним читачем." } },
  "scrollable-region-focusable": { title: { en: "A scrollable area cannot be reached with the keyboard", uk: "Прокручувана область недоступна з клавіатури" }, why: { en: "Keyboard users cannot scroll to the content inside this area.", uk: "Користувачі клавіатури не можуть прокрутити до вмісту всередині цієї області." } },
  "image-redundant-alt": { title: { en: "Image text alternative repeats the nearby text", uk: "Текстова альтернатива зображення повторює сусідній текст" }, why: { en: "A screen reader reads the same words twice, which slows reading down.", uk: "Екранний читач читає ті самі слова двічі, що сповільнює читання." } },
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
  "lighthouse:metrics": {
    pair: { en: "Lighthouse lab run: largest content paint {lcp_ms} ms (good: up to {lcp_good_ms} ms); total blocking time {tbt_ms} ms (good: up to {tbt_good_ms} ms).", uk: "Лабораторний прогін Lighthouse: відмальовування найбільшого елемента {lcp_ms} мс (добре — до {lcp_good_ms} мс); час блокування {tbt_ms} мс (добре — до {tbt_good_ms} мс)." },
    params: ["lcp_ms", "lcp_good_ms", "tbt_ms", "tbt_good_ms"],
  },
  axe: {
    pair: { en: "axe-core rule {rule} (impact: {impact}) flagged this element.", uk: "Правило axe-core {rule} (вплив: {impact}) позначило цей елемент." },
    params: ["rule", "impact"],
  },
};

// ---------------------------------------------------------------- SYNTHETIC без тексту знахідки від моделі (DEV-98)
/**
 * Коли finding-aggregator/recommendation не дали тексту (бюджет, not_supported, replay-промах): заголовок — спостереження
 * лінзи (LLM-текст, числа замасковано) або цитата сайту в шаблоні коду; проблема — що й де бачили лінзи; рекомендація —
 * дія за категорією. Жодних чисел, крім плейсхолдерів на поля звіту.
 */
export const SYNTHETIC_TEMPLATES = {
  evidence_quote: { en: "A synthetic lens marked this fragment of the page as an obstacle: “{excerpt}”.", uk: "Синтетична лінза позначила цей фрагмент сторінки як перешкоду: «{excerpt}»." },
  problem_quote: { en: "What the lenses saw on {page}: the fragment “{quote}” got in the way of the task. Pages affected: {page_count}.", uk: "Що бачили лінзи на {page}: фрагмент «{quote}» заважав виконати задачу. Сторінок: {page_count}." },
  problem_quote_sessions: { en: "What the lenses saw on {page}: the fragment “{quote}” got in the way of the task; reported in {session_frequency}. Pages affected: {page_count}.", uk: "Що бачили лінзи на {page}: фрагмент «{quote}» заважав виконати задачу; про це — {session_frequency}. Сторінок: {page_count}." },
  problem_page: { en: "The lenses reported this on {page}; the observations are in the evidence below. Pages affected: {page_count}.", uk: "Лінзи повідомили про це на {page}; спостереження — у доказах нижче. Сторінок: {page_count}." },
  problem_page_sessions: { en: "The lenses reported this on {page} in {session_frequency}; the observations are in the evidence below. Pages affected: {page_count}.", uk: "Лінзи повідомили про це на {page} ({session_frequency}); спостереження — у доказах нижче. Сторінок: {page_count}." },
} satisfies Record<string, Pair>;

/** назва категорії (для заголовка з цитатою), чому це важливо, конкретна дія за категорією */
export const CATEGORY_TEXT: Record<string, { label: Pair; why: Pair; change: Pair }> = {
  value_proposition: { label: { en: "Value proposition", uk: "Цінність пропозиції" }, why: { en: "If the benefit is unclear in the first seconds, the visitor has no reason to continue.", uk: "Якщо вигода незрозуміла в перші секунди, відвідувачеві нема причини продовжувати." }, change: { en: "State in the first screen what is sold, for whom and why it is better, in plain words.", uk: "Скажіть у першому екрані простими словами, що продається, для кого й чим це краще." } },
  navigation: { label: { en: "Navigation", uk: "Навігація" }, why: { en: "A visitor who cannot find the next step leaves instead of searching.", uk: "Відвідувач, який не знаходить наступного кроку, йде, а не шукає." }, change: { en: "Make the path to the catalogue and to the key pages visible from every page, with clear link names.", uk: "Зробіть шлях до каталогу й ключових сторінок видимим з кожної сторінки, з зрозумілими назвами посилань." } },
  product_selection: { label: { en: "Choosing a product", uk: "Вибір товару" }, why: { en: "Without criteria to choose, the visitor postpones the decision.", uk: "Без критеріїв вибору відвідувач відкладає рішення." }, change: { en: "Add filters and short plain-language descriptions that help pick the right product (who it suits, how it differs).", uk: "Додайте фільтри й короткі зрозумілі описи, що допомагають обрати товар (кому підходить, чим відрізняється)." } },
  pricing: { label: { en: "Price", uk: "Ціна" }, why: { en: "An unclear final price makes the visitor hesitate at the decision point.", uk: "Неясна кінцева ціна змушує вагатися в момент рішення." }, change: { en: "Show the full price per variant near the purchase button, including what is and is not included.", uk: "Покажіть повну ціну за варіант біля кнопки покупки, включно з тим, що входить і не входить." } },
  trust: { label: { en: "Trust", uk: "Довіра" }, why: { en: "Doubts about the seller stop a purchase even when the product fits.", uk: "Сумніви щодо продавця зупиняють покупку, навіть коли товар підходить." }, change: { en: "Put reviews, contacts, return and payment terms where the purchase decision is made.", uk: "Розмістіть відгуки, контакти, умови повернення й оплати там, де приймається рішення про покупку." } },
  shipping: { label: { en: "Delivery", uk: "Доставка" }, why: { en: "Delivery cost and time are part of the price; hidden terms cause drop-off late in the path.", uk: "Вартість і строк доставки — частина ціни; сховані умови спричиняють відмову наприкінці шляху." }, change: { en: "Show delivery options, cost and time next to the price and the purchase button.", uk: "Покажіть способи, вартість і строк доставки поруч із ціною та кнопкою покупки." } },
  terminology: { label: { en: "Terminology", uk: "Термінологія" }, why: { en: "Unexplained jargon excludes visitors who are not experts.", uk: "Непояснений фаховий жаргон відсікає відвідувачів, які не є експертами." }, change: { en: "Explain specialist terms in one short phrase or tooltip where they first appear.", uk: "Поясніть фахові терміни короткою фразою чи підказкою там, де вони з'являються вперше." } },
  visual_hierarchy: { label: { en: "Visual hierarchy", uk: "Візуальна ієрархія" }, why: { en: "When everything looks equally important, the main action gets lost.", uk: "Коли все виглядає однаково важливим, головна дія губиться." }, change: { en: "Make the main action and key information visually dominant; reduce competing elements.", uk: "Зробіть головну дію й ключову інформацію візуально домінантними; приберіть елементи, що конкурують." } },
  cta: { label: { en: "Call to action", uk: "Заклик до дії" }, why: { en: "An unclear or hidden button leaves a ready visitor without a next step.", uk: "Незрозуміла чи схована кнопка лишає готового відвідувача без наступного кроку." }, change: { en: "Use one clear primary button with an action label, visible without scrolling.", uk: "Залиште одну помітну основну кнопку з назвою дії, видиму без прокрутки." } },
  mobile_usability: { label: { en: "Mobile usability", uk: "Зручність на мобільному" }, why: { en: "Most small frictions are amplified on a phone screen.", uk: "Дрібні незручності посилюються на екрані телефона." }, change: { en: "Check the page at phone width: tap targets, text size, nothing wider than the screen.", uk: "Перевірте сторінку на ширині телефона: розмір кнопок і тексту, нічого ширшого за екран." } },
  performance: { label: { en: "Speed", uk: "Швидкість" }, why: { en: "Slow pages lose visitors before they see the offer.", uk: "Повільні сторінки втрачають відвідувачів, перш ніж ті побачать пропозицію." }, change: { en: "Reduce heavy images and scripts on this page and re-measure with Lighthouse.", uk: "Зменшіть важкі зображення й скрипти на сторінці й повторно виміряйте Lighthouse." } },
  accessibility: { label: { en: "Accessibility", uk: "Доступність" }, why: { en: "Elements that assistive technology cannot read exclude some visitors.", uk: "Елементи, які не читають допоміжні технології, відсікають частину відвідувачів." }, change: { en: "Fix the flagged elements (names, contrast, alternatives) and test with a screen reader.", uk: "Виправте позначені елементи (назви, контраст, альтернативи) і перевірте екранним читачем." } },
  content_overload: { label: { en: "Too much content", uk: "Перевантаження вмістом" }, why: { en: "Too much text hides the information needed for the decision.", uk: "Забагато тексту ховає інформацію, потрібну для рішення." }, change: { en: "Shorten the text near the decision point and move details below or into expandable sections.", uk: "Скоротіть текст біля точки рішення, а деталі перенесіть нижче чи в розгортувані блоки." } },
  missing_information: { label: { en: "Missing information", uk: "Бракує інформації" }, why: { en: "A question without an answer on the page becomes a reason to leave or to postpone.", uk: "Питання без відповіді на сторінці стає причиною піти чи відкласти покупку." }, change: { en: "Add the missing facts named in the evidence directly on this page, near the product or offer.", uk: "Додайте факти, яких бракує (вони названі в доказах), просто на цій сторінці, біля товару чи пропозиції." } },
  comparison: { label: { en: "Comparison", uk: "Порівняння" }, why: { en: "If options cannot be compared, choosing feels risky.", uk: "Якщо варіанти не можна порівняти, вибір здається ризикованим." }, change: { en: "Present comparable characteristics of similar products in the same format, ideally side by side.", uk: "Подайте порівнювані характеристики схожих товарів в однаковому форматі, бажано поруч." } },
  checkout: { label: { en: "Checkout", uk: "Оформлення замовлення" }, why: { en: "Uncertainty about the checkout steps stops visitors right before buying.", uk: "Невизначеність щодо кроків оформлення зупиняє відвідувачів просто перед покупкою." }, change: { en: "Explain the checkout steps, payment and delivery options before the visitor starts them.", uk: "Поясніть кроки оформлення, оплату й доставку до того, як відвідувач їх почне." } },
  other: { label: { en: "Other", uk: "Інше" }, why: { en: "The lenses reported an obstacle on the path to the goal.", uk: "Лінзи повідомили про перешкоду на шляху до мети." }, change: { en: "Review the quoted fragment and the observations and remove the obstacle they describe.", uk: "Перегляньте процитований фрагмент і спостереження та усуньте описану перешкоду." } },
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

export const BANNER_TEXT: Record<"replay_not_live" | "example_fixture" | "budget_limited" | "stage_failed" | "stage_skipped" | "quick_audit", Pair> = {
  replay_not_live: { en: "Synthetic results are replayed recordings, not a live model run.", uk: "Синтетичні результати — відтворені записи, а не прогін живої моделі." },
  example_fixture: { en: "Example report for interface development. It is not the result of an audit.", uk: "Приклад звіту для розробки інтерфейсу. Це не результат аудиту." },
  budget_limited: { en: "This stage stopped at the token budget; results are partial.", uk: "Етап зупинено на бюджеті токенів; результати часткові." },
  stage_failed: { en: "This stage failed; its results are missing from the report.", uk: "Етап завершився помилкою; його результатів у звіті немає." },
  stage_skipped: { en: "This stage was skipped.", uk: "Етап пропущено." },
  quick_audit: { en: "Quick audit: fewer pages, lenses and sessions were used, so coverage is lower than in a full audit.", uk: "Швидкий аудит: використано менше сторінок, лінз і сесій, тож покриття менше, ніж у повному аудиті." },
};
