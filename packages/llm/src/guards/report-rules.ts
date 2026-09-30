/**
 * Лексичний guard «жодних некаліброваних чисел» і «лінзи поведінкові» (SCORING_SPEC §7, SPEC §8, §63; S3-Fix-1).
 * Лексика узагальнена за КЛАСАМИ (словесні числівники з відмінками, частки, кратність, обсяги, перефразований
 * uplift/TAM/виручка, вигадані бенчмарки, демографія й особисті ознаки), а не за конкретними реченнями.
 *
 * Межа: це лексичний фільтр. Прогноз/твердження без жодного маркера з класів нижче він не бачить (фіксується в DEV-47
 * як відомий хибний пропуск). Правила застосовуються в межах РЕЧЕННЯ. Межі слів — `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, не `\b`.
 */
export type Issue = string;

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const alt = (body: string | string[]): string => (Array.isArray(body) ? body.join("|") : body);
const mk = (body: string | string[], flags = "iu") => new RegExp(`${L}(?:${alt(body)})${R}`, flags);
const mkStem = (body: string | string[], flags = "iu") => new RegExp(`${L}(?:${alt(body)})\\p{L}*${R}`, flags);

/** NFKC, NBSP/тонкі пробіли, апострофи, варіанти %, невидимі символи, тире → «-» */
export function normalizeText(t: string): string {
  return t
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u00a0\u2007\u2009\u202f]/g, " ")
    .replace(/[\u2019\u02bc`\u00b4\u2032\u2018]/g, "'")
    .replace(/[٪﹪％]/g, "%")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ");
}

// ------------------------------------------------------------------ числівники (слова) і цифри
const EN_UNITS = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion";
const EN_NUMW = `(?:${EN_UNITS})(?:(?:-|\\s+(?:and\\s+)?)(?:${EN_UNITS}))*`;
const UK_UNITS = [
  "нуль", "один", "одна", "одне", "одного", "одної", "одному", "одну", "одним", "двоє", "дв(?:а|і|ох|ом|ома)", "тр(?:и|ьох|ьом|ьома)", "троє", "чотир\\p{L}*", "четверо",
  "п'ят\\p{L}*", "шіст\\p{L}*", "шест\\p{L}*", "сім", "семи", "сімох", "сімо", "вісім", "восьми", "вісьм\\p{L}*", "дев'ят\\p{L}*", "десят\\p{L}*", "десяти",
  "\\p{L}*надцят\\p{L}*", "двадцят\\p{L}*", "тридцят\\p{L}*", "сорок\\p{L}*", "п'ятдесят\\p{L}*", "шістдесят\\p{L}*", "сімдесят\\p{L}*", "вісімдесят\\p{L}*", "дев'яност\\p{L}*",
  "сто", "ста", "сот\\p{L}*", "двіст\\p{L}*", "трист\\p{L}*", "півтора", "півтори", "півтисяч\\p{L}*", "тисяч\\p{L}*", "мільйон\\p{L}*", "мільярд\\p{L}*",
].join("|");
const UK_NUMW = `(?:${UK_UNITS})(?:\\s+(?:${UK_UNITS}))*`;
const DIGITS = "\\d+(?:[.,]\\d+)?";
const NUMW = `(?:${EN_NUMW}|${UK_NUMW})`;
const NUM = `(?:${DIGITS}|${NUMW})`;

// ------------------------------------------------------------------ цільові слова
/** CORE — бізнес-результат (SCORING_SPEC TARGET_BIZ): прогнози, вигадані бенчмарки */
const CORE_BODY = [
  "conversions?", "converts?", "converting", "converted", "sales", "revenues?", "turnover", "profits?", "income",
  "конверс", "конвертує", "конвертуют", "конвертув", "продаж", "вируч", "дох[оі]д", "прибут", "обіг", "оборот",
].join("|");
/** WIDE — CORE + операційні результати; лише для кратності разом із популяцією */
const WIDE_BODY = `${CORE_BODY}|orders|sign-?ups|purchases|bookings|checkouts|замовлен|реєстрац`;
const POP_BODY = [
  "customers?", "clients?", "buyers?", "shoppers?", "visitors?", "users?", "audience", "people", "consumers?", "prospects?", "market", "markets", "respondents?",
  "покупц", "покупець", "клієнт", "відвідувач", "користувач", "люд", "аудитор", "ринк", "ринок", "споживач", "респондент",
].join("|");
const TARGET_CORE = mkStem(CORE_BODY);
const TARGET_WIDE = mkStem(WIDE_BODY);
const TARGET_POP = mkStem(POP_BODY);
const MULT_NEEDS = (s: string) => TARGET_WIDE.test(s) || (TARGET_POP.test(s) && /(?:more|fewer|as\s+many|as\s+much|less|більше|менше|частіше)/iu.test(s));

// ------------------------------------------------------------------ дозволене: маскується перед перевіркою
const MASKS: RegExp[] = [
  // A1: «N of M synthetic …» (між M і synthetic ≤2 слова, не real/actual/human)
  new RegExp(`${L}\\d+\\s?(?:of|out\\s+of|/)\\s?\\d+\\s+(?:(?!(?:real|actual|human)${R})\\p{L}+\\s+){0,2}(?:synthetic|simulated)\\s+\\p{L}+`, "giu"),
  new RegExp(`${L}(?:[ув]\\s+)?\\d+\\s?(?:з|із|зі|/)\\s?\\d+\\s+(?:(?!(?:реальн|справжн|живих)\\p{L}*)\\p{L}+\\s+){0,2}(?:синтетичн\\p{L}*|змодельован\\p{L}*|симульован\\p{L}*)\\s+\\p{L}+`, "giu"),
  // A2: наш індекс і оцінки інструментів
  /(?:priority|пріоритет\p{L}*|score|оцінк\p{L}*|бал\p{L}*|lighthouse\s+\p{L}+|performance|accessibility|seo|best practices)\s*:?\s*\d+\s?(?:\/|of|з|із)\s?100/giu,
  /\d+\s?\/\s?100(?![\d])(?!\s+(?:customers?|clients?|users?|visitors?|shoppers?|buyers?|people|покупц|клієнт|користувач|відвідувач|люд))/giu,
  // омоніми, що не є твердженням про бізнес-результат
  /(?<![\p{L}\p{N}])(?:sales\s+(?:page|team|funnel|copy|tax|pitch|manager|department|contact|rep|deck)s?|conversion\s+(?:path|funnel|goal|point|event|tracking|element|action|flow|barrier|blocker|friction|copy|page|paths|goals|events|elements|actions)s?|in\s+order\s+to|order\s+(?:form|summary|number|status|confirmation|page|history)|конверсійн\p{L}*|сторінк\p{L}*\s+продаж\p{L}*|воронк\p{L}*\s+продаж\p{L}*|відділ\p{L}*\s+продаж\p{L}*|(?:маркетингов|податк|цінов)\p{L}*\s+продаж\p{L}*)(?![\p{L}\p{N}])/giu,
  // дати
  /(?<![\p{L}\p{N}])\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}%])/gu,
  // розміри viewport/зображень і виміри з доказів
  /\d+\s?[x×х]\s?\d+(?:\s?[x×х]\s?\d+)?/giu,
  /\d[\d.,]*\s?(?:px|rem|em|pt|vh|vw|ms|kib|kb|mib|mb|gib|gb|kbps|mbps|hz|khz|mhz|ghz|dpi|ppi|fps|мс|кб|мб|гб|мм|см|cm|mm|байт\p{L}*|секунд\p{L}*|seconds?|sec|s|kbytes|bytes?)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:h[1-6]|wcag\s?\d(?:\.\d)+|\d\.\d\.\d+|http\/[\d.]+|utf-8)(?![\p{L}\p{N}])/giu,
];
/** маска не повинна перетинатись із %, тож «12% від 1280x720» лишає «12%» */
function applyMasks(t: string): string {
  let s = t;
  for (const re of MASKS) s = s.replace(re, " ⟂ ");
  return s.replace(/\s+/g, " ");
}

const sentences = (t: string): string[] => t.split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"'(])|\n+/u).map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------ правила (реченнєвий рівень)
const PCT_UNIT = "%|percent(?:age)?(?:\\s+points?)?|per[ -]?cent|pct|pp|p\\.p\\.|відсот\\p{L}*|процент\\p{L}*|в\\.\\s?п\\.";
const CURRENCY = "usd|eur|uah|gbp|грн\\.?|гривн\\p{L}*|гривен\\p{L}*|долар\\p{L}*|dollars?|euros?|євро|pounds?|фунт\\p{L}*|\\$|€|£|₴";
const MAG_WORDS = "тис\\.?|тисяч\\p{L}*|млн\\.?|мільйон\\p{L}*|млрд\\.?|мільярд\\p{L}*|thousands?|millions?|billions?|mln|bln|bn";
const MAG_PLURAL = "thousands|millions|billions|hundreds\\s+of\\s+thousands|тисячі|тисяч|мільйони|мільйонів|мільярди|мільярдів|сотні\\s+тисяч|десятки\\s+тисяч";

interface Rule { id: string; re: RegExp; needs?: (s: string) => boolean; note: string; evidenceSensitive?: boolean }

const POP_NEAR = `(?:\\s+(?!(?:for|on|in|at|with|to|of|by|from|на|для|у|в|з|до|по|із|зі)${R})\\p{L}+){0,2}\\s+`;
const POP_WORDS = "market|markets|ринк\\p{L}*|ринок|customers?|clients?|buyers?|shoppers?|visitors?|users?|people|consumers?|respondents?|покупц\\p{L}*|покупець|клієнт\\p{L}*|відвідувач\\p{L}*|користувач\\p{L}*|люд\\p{L}*|споживач\\p{L}*|респондент\\p{L}*|аудитор\\p{L}*";

const FRACTION = "half|halves|(?:a\\s+|one[- ]|two[- ]|three[- ]|four[- ]|nine[- ])?(?:third|thirds|quarter|quarters|fifth|fifths|tenth|tenths|sixth|eighth)|majority|minority|nearly\\s+all|almost\\s+all|almost\\s+everyone|"
  + "половин\\p{L}*|третин\\p{L}*|чверт\\p{L}*|п'ят(?:а|ої|у)\\s+частин\\p{L}*|десят\\p{L}*\\s+частин\\p{L}*|більшіст\\p{L}*|меншіст\\p{L}*|переважн\\p{L}*\\s+більшіст\\p{L}*|майже\\s+всі|майже\\s+кож(?:ен|н\\p{L}*)|"
  + "кож(?:ен|н\\p{L}*)\\s+(?:другий|друга|друге|другого|третій|третя|третє|третього|четвер\\p{L}*|п'ят\\p{L}*|шост\\p{L}*|сьом\\p{L}*|десят\\p{L}*)";

const RULES: Rule[] = [
  // --- відсотки словом і цифрою (цифрові перевіряються проти доказів окремо)
  { id: "invented_percent", re: new RegExp(`${L}${NUMW}(?:-|\\s)?(?:${PCT_UNIT})${R}`, "iu"), note: "відсоток словом" },
  // --- частки: дробове слово поруч (≤3 слова) з популяційним/бізнес-словом
  {
    id: "invented_number",
    re: new RegExp(`${L}(?:${FRACTION})${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:${POP_WORDS}|${CORE_BODY}\\p{L}*)${R}`, "iu"),
    note: "частка/більшість про популяцію чи бізнес-результат",
  },
  {
    id: "invented_number",
    re: new RegExp(`${L}(?:${POP_WORDS})${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:${FRACTION})${R}`, "iu"),
    note: "популяція + частка",
  },
  {
    id: "invented_number",
    re: new RegExp(`(?<!(?:the|a|an)\\s)${L}most\\s+(?:of\\s+(?:the\\s+|our\\s+|your\\s+|all\\s+|these\\s+|those\\s+)?)?(?:${POP_WORDS})${R}`, "iu"),
    note: "«most <люди>» — частка без числа",
  },
  // --- співвідношення N з M <популяція> (цифри/слова); «synthetic» замасковано вище
  {
    id: "invented_number",
    re: new RegExp(`${L}${NUM}\\s?(?:of|out\\s+of|in|з|із|зі|на\\s+кожні|з\\s+кожних|per|на)\\s?(?:every\\s+|each\\s+|кожних\\s+)?${NUM}${POP_NEAR}(?:${POP_WORDS})${R}`, "iu"),
    note: "співвідношення N з M про реальних людей",
  },
  { id: "invented_number", re: new RegExp(`${L}${NUM}\\s+(?:${POP_WORDS})\\s+(?:out\\s+of|of|in|per|з|із|зі|на)\\s+${NUM}${R}`, "iu"), note: "N <люди> із M" },
  { id: "invented_number", re: new RegExp(`${L}\\d+\\s+(?:${POP_WORDS})${R}(?:\\s+\\p{L}+){0,3}?[,;:\\s]+\\d+\\s+(?:${POP_WORDS})${R}`, "iu"), note: "два лічильники людей поряд (неявне співвідношення)" },
  // --- частка без знака %
  {
    id: "invented_number",
    re: new RegExp(`${L}(?:share|proportion|percentage|fraction|portion|ratio|част\\p{L}*|відсоток|пропорці\\p{L}*|питом\\p{L}*\\s+ваг\\p{L}*)\\s+(?:of\\s+)?(?:the\\s+|our\\s+|your\\s+|all\\s+)?(?:\\p{L}+\\s+){0,2}?(?:${POP_WORDS})${R}`, "iu"),
    needs: (s) => new RegExp(`${L}(?:${DIGITS}|${NUMW})${R}`, "iu").test(s),
    note: "частка популяції з числом",
  },
  // --- кратність
  { id: "invented_number", re: new RegExp(`${L}\\d+(?:[.,]\\d+)?\\s?[x×х](?![\\p{L}\\p{N}])`, "iu"), needs: MULT_NEEDS, note: "Nx про бізнес/людей" },
  {
    id: "invented_number",
    re: new RegExp(`${L}(?:twice|double[sd]?|doubling|triple[sd]?|tripling|treble[sd]?|quadruple[sd]?|(?:${EN_NUMW}|\\d+)[- ]?fold|(?:${NUM})\\s+times(?=\\s+(?:more|as|higher|greater|bigger|larger|better|faster|fewer|less|lower))|`
      + `удвічі|вдвічі|вдвоє|утричі|втричі|втроє|вчетверо|вп'ятеро|вдесятеро|подвоїт\\p{L}*|подвоєн\\p{L}*|подвоїть\\p{L}*|потроїт\\p{L}*|потроєн\\p{L}*|`
      + `(?:у|в)\\s+(?:${NUM})\\s+раз(?:и|ів|у)?|(?:${NUM})\\s+раз(?:и|ів)\\s+(?:більше|менше|вище|нижче|частіше|швидше))${R}`, "iu"),
    needs: MULT_NEEDS,
    note: "кратність (двічі/утричі/Nx) про бізнес або людей",
  },
  // --- гроші й обсяги
  {
    id: "invented_tam",
    re: new RegExp(`(?:${L}(?:${CURRENCY})\\s?${NUM}\\s?(?:${MAG_WORDS}|[kKmM]|bn)${R}|${L}${NUM}\\s?(?:${MAG_WORDS})${R}|${L}(?:${MAG_PLURAL})\\s+(?:of\\s+)?(?:${CURRENCY}|${POP_WORDS})${R})`, "iu"),
    evidenceSensitive: true,
    note: "обсяг/гроші з порядком (тис./млн/мільйон/thousand/million…)",
  },
  { id: "invented_tam", re: new RegExp(`${L}\\d+(?:[.,]\\d+)?[kKmM]${R}`, "u"), needs: (s) => !/(?:photo|image|video|screen|display|resolution|monitor|texture|фото|зображ|відео|екран|роздільн|монітор)/iu.test(s), evidenceSensitive: true, note: "число з k/M" },
  { id: "invented_tam", re: new RegExp(`(?:${L}(?:${CURRENCY})\\s?\\d[\\d ]{5,}\\d|${L}\\d[\\d ]{5,}\\d\\s?(?:${CURRENCY})${R})`, "iu"), evidenceSensitive: true, note: "грошова сума ≥ 6 цифр без доказу" },
  // --- ринок / TAM / виручка / uplift (в т.ч. перефразовані)
  { id: "invented_tam", re: mk("TAM|SAM|SOM|ARPU|CAC|LTV|AOV|ROI|ROAS|CLV|MRR|ARR", "u"), note: "TAM/SAM/SOM/бізнес-метрика" },
  {
    id: "invented_tam",
    re: mkStem([
      "total\\s+addressable", "addressable\\s+market", "serviceable\\s+(?:addressable\\s+)?market", "obtainable\\s+market", "market\\s+(?:size|share|volume|opportunity|potential|capacity|worth|valuation|value|cap)", "share\\s+of\\s+(?:the\\s+)?market", "market\\s+is\\s+(?:worth|valued|estimated)",
      "size\\s+of\\s+(?:the\\s+)?market", "(?:potential|addressable|target)\\s+market\\s+(?:of|is)", "market\\s+for\\s+[\\p{L}\\s]{1,30}?\\s+(?:is|reaches|exceeds)\\s+(?:${NUM})",
      "розмір\\s+(?:\\p{L}+\\s+){0,2}ринк", "(?:обсяг|ємніст|місткіст)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}ринк", "size\\s+of\\s+(?:the\\s+)?(?:\\p{L}+\\s+){0,2}market", "(?:overall|total|target|global|local)\\s+market\\s+(?:size|is|of)", "част\\p{L}+\\s+ринку", "ринков\\p{L}*\\s+(?:част|обсяг|потенціал|оцінк|вартіст|розмір)", "ринок\\s+(?:оцінюється|складає|становить|коштує|вартує|сягає|перевищує)",
      "оцінк\\p{L}*\\s+ринку", "потенціал\\p{L}*\\s+ринку", "вартіст\\p{L}*\\s+ринку", "доступн\\p{L}*\\s+ринок", "цільов\\p{L}*\\s+ринок\\s+(?:складає|становить|оцінюється)",
    ].join("|").replace("${NUM}", NUM)),
    note: "розмір/частка/потенціал ринку",
  },
  {
    id: "invented_tam",
    re: mkStem(["conversion\\s+rate", "conversion\\s+uplift", "uplift", "конверс\\p{L}*\\s+(?:зросте|виросте|підвищ)", "апліфт", "приріст\\p{L}*\\s+(?:конверс|продаж|виручк|дох|прибут)"].join("|")),
    note: "uplift/метрика бізнес-результату",
  },
  { id: "invented_tam", re: mkStem(["revenue", "виручк", "вируч"]), note: "виручка" },
  // --- перефразовані прогнози бізнес-результату: дієслово-«рух» + бізнес-результат (G2)
  {
    id: "invented_forecast",
    re: new RegExp(
      `${L}(?:will|would|could|can|may|might|is\\s+going\\s+to|likely\\s+to|expected\\s+to|bound\\s+to|set\\s+to)\\s+(?:\\p{L}+\\s+){0,2}?(?:increase|grow|boost|rise|improve|lift|double|triple|drop|fall|decline|decrease|raise|drive|generate|bring|add|yield|cut|reduce|hurt|damage|lose|gain|recover|multiply|accelerate)${R}`, "iu"),
    needs: (s) => TARGET_CORE.test(s),
    note: "прогноз бізнес-результату",
  },
  {
    id: "invented_forecast",
    re: mkStem(["зросте", "зростуть", "збільшить", "збільшаться", "підвищить", "підвищаться", "виросте", "виростуть", "подвоїться", "подвояться", "впаде", "впадуть", "знизить", "знизяться", "зменшить", "зменшаться", "покращить", "поліпшить", "додасть", "принесе", "принесуть", "приведе", "прискорить", "збільшити", "підвищити", "покращити", "зрости"].join("|")),
    needs: (s) => TARGET_CORE.test(s),
    note: "прогноз бізнес-результату (uk)",
  },
  {
    id: "invented_forecast",
    re: new RegExp(`${L}(?:lead(?:s|ing)?\\s+to|result(?:s|ing)?\\s+in|translat\\p{L}*\\s+(?:in)?to|drive[sn]?|generat\\p{L}*|yield\\p{L}*|bring(?:s|ing)?)\\s+(?:\\p{L}+\\s+){0,2}?(?:more|higher|better|greater|increased|additional|extra|fewer|lower|less)\\s+(?:\\p{L}+\\s+){0,1}?(?:${CORE_BODY}\\p{L}*)${R}`, "iu"),
    note: "«приведе до більшої кількості продажів»",
  },
  {
    id: "invented_forecast",
    re: mkStem(["приведе\\s+до\\s+(?:зростання|збільшення|підвищення|падіння)", "призведе\\s+до\\s+(?:зростання|збільшення|підвищення|падіння|втрат)", "(?:зростання|збільшення|підвищення|приріст|падіння|втрат\\p{L}*)\\s+(?:\\p{L}+\\s+)?(?:конверс|продаж|виручк|дох|прибут|замовлен)", "втрачен\\p{L}*\\s+(?:продаж|замовлен|клієнт|покупц|виручк|дох|прибут)", "(?:lost|missed)\\s+(?:sales|orders|customers|revenue|conversions|profit|income)", "money\\s+(?:left\\s+)?on\\s+the\\s+table"].join("|")),
    note: "перефразований прогноз/втрата бізнес-результату",
  },
  {
    id: "invented_forecast",
    re: new RegExp(`${L}(?:(?:more|higher|better|greater|bigger|extra|additional|increased)\\s+(?:${CORE_BODY})\\p{L}*|(?:${CORE_BODY})\\p{L}*\\s+(?:lift|boost|growth|uplift|increase|gain|drop|loss))${R}`, "iu"),
    needs: (s) => /(?:will|would|could|can|may|might|should|likely|expected|potentially|expect|прогноз|очіку|може|можуть|ймовірно)/iu.test(s),
    note: "«more sales» у прогнозному реченні",
  },
  // --- перефразована «виручка» (дохід/оборот/прибуток/заробіток) у зв'язці з рухом
  {
    id: "invented_tam",
    re: new RegExp(
      `${L}(?:turnover|income|earnings|takings|profits?|cash\\s?flow|дохід\\p{L}*|доход\\p{L}*|прибут\\p{L}*|оборот\\p{L}*|обіг\\p{L}*|заробіт\\p{L}*|заробл\\p{L}*)${R}`, "iu"),
    needs: (s) => new RegExp(`${L}(?:lose|losing|lost|leak\\p{L}*|earn\\p{L}*|generat\\p{L}*|bring\\p{L}*|cost\\p{L}*|add\\p{L}*|boost\\p{L}*|grow\\p{L}*|increas\\p{L}*|reduc\\p{L}*|hurt\\p{L}*|drop\\p{L}*|forgo\\p{L}*|miss\\p{L}*|will|would|could|may|might|estimat\\p{L}*|annual|monthly|yearly|weekly|per\\s+(?:month|year|day)|втрача\\p{L}*|втрат\\p{L}*|недоотрим\\p{L}*|приноси\\p{L}*|принес\\p{L}*|зрост\\p{L}*|збільш\\p{L}*|скороч\\p{L}*|зменш\\p{L}*|падіння|приріст|збитк\\p{L}*|коштува\\p{L}*|річн\\p{L}*|місячн\\p{L}*|щомісяц\\p{L}*|щороку|на\\s+(?:місяць|рік)|орієнтовн\\p{L}*|оцінюєть\\p{L}*|складає|становить)${R}`, "iu").test(s),
    note: "перефразований дохід/оборот/прибуток",
  },
  { id: "invented_number", re: /\(\s*[~≈+-]?\s*\d+(?:[.,]\d+)?\s*-\s*[+-]?\d+(?:[.,]\d+)?\s*\)/u, needs: (s) => TARGET_CORE.test(s), note: "числовий діапазон у дужках про бізнес-результат" },
  // --- вигадані бенчмарки без джерела
  {
    id: "invented_benchmark",
    re: new RegExp(`${L}(?:typically|usually|generally|normally|commonly|on\\s+average|as\\s+a\\s+rule|industry[- ](?:average|standard|benchmark|norm|typical)|the\\s+(?:average|typical)\\s+(?:site|store|shop|website|business|e-?commerce)|average\\s+(?:site|store|shop|website|e-?commerce)|studies\\s+(?:show|suggest|indicate|found)|research\\s+(?:shows|suggests|indicates|found)|surveys?\\s+(?:show|suggest|indicate|found)|according\\s+to\\s+(?:industry|studies|research|surveys?)|benchmarks?\\s+(?:show|suggest|indicate)|зазвичай|як\\s+правило|типов\\p{L}*|у\\s+середньому|в\\s+середньому|середн\\p{L}*\\s+(?:по\\s+галузі|для\\s+галузі|показник\\p{L}*\\s+галузі)|галузев\\p{L}*\\s+(?:середн\\p{L}*|стандарт\\p{L}*|норм\\p{L}*|показник\\p{L}*|бенчмарк\\p{L}*)|дослідження\\s+(?:показують|свідчать|доводять)|за\\s+даними\\s+(?:галуз\\p{L}*|досліджен\\p{L}*|опитувань)|опитування\\s+(?:показують|свідчать))${R}`, "iu"),
    needs: (s) => new RegExp(`${L}(?:conver\\p{L}*|sales|revenue|bounce(?:\\s+rate)?|abandon\\p{L}*|click-?through|CTR|retention|purchase\\s+rate|checkout\\s+completion|drop-?offs?|продаж\\p{L}*|конверс\\p{L}*|конверт\\p{L}*|вируч\\p{L}*|відмов\\p{L}*|покинут\\p{L}*|утриман\\p{L}*)${R}`, "iu").test(s),
    note: "бенчмарк/«типово» без джерела в доказах",
  },
  // --- спеціфічні (SCORING_SPEC §7.3 A)
  { id: "invented_tam", re: new RegExp(`${L}(?:customers?\\s+(?:lost|losing)|(?:lose|losing|lost)\\s+(?:\\d+\\s?%?\\s+)?(?:of\\s+)?(?:your\\s+)?customers|втрача\\p{L}*\\s+(?:\\d+\\s?%?\\s+)?(?:\\p{L}+\\s+)?(?:клієнт|покупц)\\p{L}*)${R}`, "iu"), note: "втрата клієнтів" },
  { id: "invented_benchmark", re: new RegExp(`${L}(?:(?:real|actual)\\s+(?:customers|users|people)\\s+(?:prefer|choose|want)|реальн\\p{L}*\\s+(?:клієнт|покупц|користувач)\\p{L}*\\s+(?:віддають\\s+перевагу|обирають|хочуть))${R}`, "iu"), note: "заява про «реальних» людей" },
  { id: "invented_benchmark", re: new RegExp(`(?:\\d+(?:[.,]\\d+)?\\s?%\\s+(?:confiden|впевнен)\\p{L}*|(?:confidence|впевненіст\\p{L}*)\\s+(?:of\\s+|level\\s+)?\\d+(?:[.,]\\d+)?\\s?%|statistically\\s+significant|статистично\\s+значущ\\p{L}*)`, "iu"), note: "статистична впевненість" },
];

const PERCENT_DIGITS = new RegExp(`${L}(${DIGITS})\\s?(?:${PCT_UNIT})${R}`, "giu");

/** всі порушення числового guard-а у ОДНОМУ полі. `evidenceCorpus` — видимий текст/метадані сторінок (для цифр, які могли бути на сайті). */
export function numericViolations(rawText: string, evidenceCorpus = ""): Issue[] {
  const out: Issue[] = [];
  const text = normalizeText(rawText);
  const corpus = normalizeText(evidenceCorpus).toLowerCase();
  // 1) відсотки цифрою: дозволені лише ті, що є в доказах (маскування дат/розмірів не зачіпає «N%»)
  for (const m of text.matchAll(PERCENT_DIGITS)) {
    const num = m[1] as string;
    const seen = new RegExp(`${L}${num.replace(/[.,]/, "[.,]")}\\s?(?:${PCT_UNIT})${R}`, "iu");
    if (!seen.test(corpus)) out.push(`invented_percent: «${m[0]}» немає в наданих доказах`);
  }
  // 2) решта — за реченнями, після маскування дозволених форм
  const masked = applyMasks(text);
  const seenIds = new Set<string>();
  for (const s of sentences(masked)) {
    for (const rule of RULES) {
      const m = rule.re.exec(s);
      if (!m) continue;
      if (rule.needs && !rule.needs(s)) continue;
      const span = m[0].trim();
      if (rule.evidenceSensitive && corpus && /\d/.test(span) && corpus.includes(span.toLowerCase())) continue;
      const key = `${rule.id}:${span.toLowerCase()}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      out.push(`${rule.id}: «${span}» — ${rule.note}; не виводиться з доказів`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ демографія й особисті ознаки (лінзи поведінкові, §8)
const AGE_CTX = "people|users?|customers?|adults?|shoppers?|buyers?|visitors?|persons?|those|clients?";
const DEMO_EN = mk([
  "woman", "women", "man", "men", "male", "females?", "girls?", "boys?", "gender", "sex", "non-binary", "transgender", "lgbt\\p{L}*", "sexual\\s+orientation",
  "elderly", "elders?", "pensioners?", "retire[de]s?", "retirees?", "retirement[- ]age", "seniors", "senior\\s+citizens?", "senior\\s+(?:users?|customers?|shoppers?|people|adults?)", "old\\s+(?:people|folks|users|customers|shoppers|men|women|ladies)", "older\\s+(?:adults?|people|folks|users|customers|shoppers|generation|persons?|men|women)",
  "young", "younger", "youths?", "youngsters?", "kids?", "child", "children", "teens?", "teenagers?", "adolescents?", "toddlers?", "minors?",
  "millennials?", "gen[- ]?[xyz]", "zoomers?", "boomers?", "baby\\s+boomers?", "generation\\s+[xyz]", "middle[- ]aged", "(?:twenty|thirty|forty|fifty|sixty)[- ]?somethings?",
  "age\\s+(?:group|range|bracket|band|of\\s+\\d+|\\d+)", "aged\\s+\\d+", "ages\\s+\\d+", "\\d+[- ]?(?:year|yr)s?[- ]?olds?",
  `(?:${AGE_CTX})\\s+(?:aged\\s+)?(?:under|over|above|below)\\s+\\d{2}`, `\\d{2}s?\\s+(?:and|or)\\s+(?:older|younger|under|over|up)`, `(?:${AGE_CTX})\\s+\\d{2}\\+`,
  "mom", "moms", "mum", "mums", "mommy", "mommies", "mother", "mothers", "dad", "dads", "father", "fathers", "grandparents?", "grandmas?", "grandmothers?", "grandfathers?", "grandpas?", "stay-at-home", "housewife", "housewives", "homemakers?",
  "(?:busy|working|new|young|single|first-time|stressed|tired|modern|expecting)\\s+parents?", "parents?\\s+(?:of|with|who|looking|shopping|and\\s+(?:kids|children))",
  "single\\s+(?:mothers?|fathers?|parents?|men|women|people|adults?)",
  "married", "unmarried", "divorced", "widow(?:ed|s)?", "widowers?", "newlyweds?", "bachelors?", "spouses?", "husbands?", "wives", "wife", "couples?", "marital", "relationship\\s+status", "family\\s+status", "family\\s+(?:with|of)\\s+(?:young\\s+)?(?:kids|children)",
  "students?", "pupils?", "undergrad\\p{L}*", "graduates?", "schoolchildren", "schoolgirls?", "schoolboys?", "freshers?",
  "occupation", "profession", "job\\s+title", "employment\\s+status", "by\\s+profession", "blue[- ]collar", "white[- ]collar", "office\\s+workers?", "construction\\s+workers?", "factory\\s+workers?", "unemployed", "jobless", "freelancers?", "entrepreneurs?", "farmers?", "teachers?", "nurses?", "lawyers?", "accountants?",
  "(?:busy|working|office|remote|full-time|part-time)\\s+(?:professionals?|workers?|employees?)",
  "low-income", "high-income", "middle-income", "wealthy", "affluent", "(?:rich|poor)\\s+(?:people|families|users|customers|shoppers)", "income\\s+(?:bracket|level|group)", "immigrants?", "migrants?", "refugees?", "ethnic", "ethnicity", "race", "racial", "nationality", "christian", "muslim", "jewish", "catholic", "hindu", "buddhist", "religious", "religion", "atheist",
].join("|"));
const DEMO_UK = mkStem([
  "жінк", "жіноч", "чолов", "дівч", "хлопц", "хлопчик", "хлопчач", "стать", "статев", "гендер", "лгбт",
  "пенсіонер", "пенсійн", "літн", "похилого", "старш(?:і|их|им|ими)\\s+(?:люд|користувач|клієнт|покупц|віку|вік)", "старенн", "старі\\s+люд", "молодь", "молод(?:і|их|им|ими|а|ий|ою|ої|у)\\s+(?:люд|користувач|клієнт|покупц|мам|батьк|сім|фахівц|профес|чолов|жін|дівч|хлоп)", "юн(?:ак|а|і|их|ий)", "підлітк", "дитин", "діти", "дітей", "дітьми", "дітям", "малюк", "дошкільн", "школяр", "учн(?:і|ів|ям|ями|иц)", "студент", "аспірант", "випускник",
  "мам(?=[аиуоєі])", "мамок", "татус", "батьк", "бабус", "дідус", "домогосподар", "одружен", "неодружен", "холост", "розлучен", "вдів", "вдовц", "заміжн", "подружж", "сімейн\\p{L}*\\s+(?:стан|пар)", "молодят", "самотні\\s+(?:мам|батьк|люд)",
  "рід\\s+занять", "професі(?:я|ї|ю|єю)", "за\\s+професією", "безробітн", "фрілансер", "підприємц", "фермер", "вчител", "педагог", "медсестр", "юрист", "бухгалтер", "офісн\\p{L}*\\s+(?:працівник|співробітник)", "робітник", "синьокомірцев", "білокомірцев", "(?:зайнят|працюючі|віддален)\\p{L}*\\s+(?:професіонал|фахівц|працівник)",
  "заможн", "бідн", "малозабезпеч", "багат(?:і|их|им|ими)\\s+(?:люд|клієнт|покупц)", "високо-?дохідн", "низько-?дохідн", "середн\\p{L}*\\s+клас", "рівень\\s+доходу", "мігрант", "біженц", "емігрант", "національн", "етнічн", "расов", "релігій", "релігійн", "християн", "мусульман", "єврей", "буддист", "атеїст",
  "\\d+[- ]?річн", "віком\\s+\\d+", "віков\\p{L}*", "(?:до|понад|старше|молодше)\\s+\\d{2}\\s+(?:років|роки|р\\.)", "\\d{2}\\s?-\\s?\\d{2}\\s+(?:років|роки|р\\.)",
].join("|"));
// без стем-суфікса: щоб не зачепити «вікно», «матеріали»
const DEMO_UK_EXACT = mk("вік|віку|віком|віці|віки|тато|тата|тату|татові|матір|матері|матерів|матерям|матерями|дитяч\\p{L}*|тінейджер\\p{L}*|мілленіал\\p{L}*|зумер\\p{L}*|бумер\\p{L}*|пенсія|пенсії|мама|мами|мамі|маму|мамою|мамо|дружина|дружини|дружину|чоловік|чоловіка");

export function demographicViolations(rawText: string): Issue[] {
  const t = normalizeText(rawText);
  const out: Issue[] = [];
  const d = DEMO_EN.exec(t) ?? DEMO_UK.exec(t) ?? DEMO_UK_EXACT.exec(t);
  if (d) out.push(`lens_demographics: демографічна/особиста ознака «${d[0]}» (лінза має бути поведінковою, §8)`);
  // відсотки, частки й співвідношення про популяцію — у лінзах заборонені завжди (§8, §63)
  const pct = /\d\s?%/u.exec(t) ?? new RegExp(`${L}(?:${PCT_UNIT})${R}`, "iu").exec(t);
  if (pct) out.push(`lens_market_percent: «${pct[0].trim()}» — лінза не має відсотків/частки ринку (§8, §63)`);
  else {
    const m = numericViolations(t, "").find((v) => v.startsWith("invented_percent") || v.startsWith("invented_number"));
    if (m) out.push(`lens_market_percent: ${m.replace(/^[a-z_]+:\s*/, "")}`);
  }
  return out;
}
