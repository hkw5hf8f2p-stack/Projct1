/**
 * Виявлення «інструкції до AI» в ЦИТАТІ зі сторінки (G0-12; S7 прогін B: модель не виконала ін'єкцію, але процитувала її дослівно як friction).
 * Це не guard прози моделі (для неї — `findInjectionEcho`), а перевірка ДОКАЗУ: цитата, що містить звернення до асистента, спробу
 * перевизначити інструкції, канарку чи ціль deny-list (G0-11), не потрапляє у звіт дослівно — friction відкидається кодом, замість неї —
 * знеособлений код-шаблон «на сторінці є текст, схожий на інструкцію для AI-асистента» без відтворення тексту.
 * Правила узагальнені за КЛАСАМИ (не за одним рядком фікстури). Межі слів — Unicode-класи (G0-26), не `\b`.
 * Обмеження (unverified на живих сайтах): евристика; хибнопозитив = friction із цитатою про «AI-асистента» відхилено (безпечний напрям), хибнонегатив = перефразована інструкція.
 */
import { FORBIDDEN_ACTIONS } from "./text.js";

const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";
/** адресат «до AI» (без «model/agent/bot»: це звичайні слова каталогу/сервісу) */
const AI = "(?:a\\.?i\\.?|assistants?|llms?|language\\s+models?|chat\\s?bots?|chat\\s?gpt|gpt|claude|gemini|copilot|ai\\s+(?:agents?|models?|assistants?))";
const rx = (src: string) => new RegExp(src, "iu");

export interface InjectionRule { id: string; re: RegExp }
export const AI_INSTRUCTION_RULES: readonly InjectionRule[] = [
  { id: "override_instructions", re: rx(`${L}(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+|every\\s+)?(?:of\\s+)?(?:the\\s+|your\\s+|these\\s+|those\\s+)?(?:previous|prior|above|earlier|preceding|system|developer|original|initial)?\\s*(?:instructions?|prompts?|rules|guidelines|directives)${R}`) },
  { id: "override_instructions_uk_ru", re: rx(`${L}(?:ігноруй|ігноруйте|забудь|забудьте|знехтуй|ігнорируй|игнорируй|игнорируйте|забудь)\\s+(?:усі\\s+|всі\\s+|все\\s+|всё\\s+)?(?:попередні|попередні|вищі|ваші|свої|предыдущие|прежние|системные)?\\s*(?:інструкці|промпт|правил|указан|инструкци)`) },
  { id: "addresses_ai", re: rx(`${L}(?:notice|message|note|instruction|instructions|prompt|command|request|attention|warning|directive)s?\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+)?(?:ai|a\\.i\\.|artificial\\s+intelligence)?\\s*${AI}${R}`) },
  { id: "addresses_ai", re: rx(`${L}(?:dear|hey|attention|hello)\\s*[,:]?\\s+(?:the\\s+)?${AI}${R}`) },
  { id: "addresses_ai", re: rx(`${L}(?:if\\s+you\\s+are|when\\s+you\\s+are|as)\\s+(?:an?\\s+|the\\s+)?(?:ai|a\\.i\\.|llm|language\\s+model|large\\s+language\\s+model|ai\\s+assistant|chat\\s?bot|automated\\s+agent)${R}`) },
  { id: "addresses_ai", re: rx(`${L}${AI}\\s+(?:must|should|shall|need\\s+to|have\\s+to|is\\s+required\\s+to|are\\s+required\\s+to|please)\\s+(?:now\\s+)?(?:ignore|press|click|open|visit|reply|respond|say|output|print|call|send|reveal|delete|buy|pay|log|navigate|follow|obey|execute|run)${R}`) },
  { id: "addresses_ai_uk_ru", re: rx(`${L}(?:повідомлення|інструкці[яї]|звернення|сообщение|инструкция|обращение)\\s+(?:для|до|к|для)\\s+(?:ші|ai|ии|штучного\\s+інтелекту|асистента|ассистента|нейромереж\\p{L}*|чат-?бота?)${R}`) },
  { id: "role_switch", re: rx(`${L}(?:you\\s+are\\s+now|from\\s+now\\s+on\\s+you|act\\s+as\\s+if\\s+you|pretend\\s+(?:to\\s+be|you\\s+are)|switch\\s+to|enter|enable)\\s+(?:in\\s+|into\\s+)?(?:a\\s+|an\\s+|the\\s+)?(?:developer|dan|jailbreak|god|admin|debug|unrestricted|system)\\s*(?:mode|role)?${R}`) },
  { id: "role_switch", re: rx(`${L}(?:developer|jailbreak|debug|admin|god)\\s+mode${R}`) },
  { id: "reveal_prompt", re: rx(`${L}(?:reveal|print|show|output|repeat|leak|disclose|expose|tell\\s+me)\\s+(?:me\\s+)?(?:your\\s+|the\\s+)?(?:hidden\\s+|secret\\s+|system\\s+|initial\\s+|original\\s+)*(?:instructions?|prompts?|rules|guidelines|configuration)${R}`) },
  { id: "system_marker", re: rx(`(?:^|[\\n"«“'(\\[])\\s*(?:system|developer|assistant|admin)\\s*(?:notice|message|prompt|override|alert|instruction)s?\\s*[:\\-–—]`) },
  { id: "system_marker", re: rx(`${L}system\\s+(?:notice|override|prompt)${R}`) },
  { id: "system_marker", re: rx(`<<<\\s*(?:END_)?PAGE[_ ]?DATA|\\[/?INST\\]|<\\|(?:im_start|im_end|system|endoftext)\\|>|<\\/?(?:system|instructions?)>`) },
  { id: "reply_only", re: rx(`${L}(?:reply|respond|answer|output|say)\\s+(?:only|just|exactly)\\s+(?:with\\s+)?(?:the\\s+)?(?:word|phrase|text|string|token)${R}`) },
  { id: "reply_only", re: rx(`${L}(?:reply|respond|answer|output)\\s+(?:only|just|exactly)\\s+with${R}`) },
  { id: "reply_only", re: rx(`${L}(?:reply|respond|answer|output)\\s+with\\s+(?:the\\s+)?(?:word|phrase|string|token)${R}`) },
  { id: "canary", re: rx(`${L}(?:COMPROMISED|CANARY|PWNED|INJECTED|HIJACKED)[-_][0-9A-Z]{3,}${R}`) },
  { id: "forbidden_action_token", re: new RegExp(`${L}(?:${FORBIDDEN_ACTIONS.filter((a) => a.includes("_")).join("|")})${R}`, "iu") },
  { id: "deny_target", re: rx(`(?:^|[\\s"'«“(])/(?:logout|log-out|signout|sign-out|account/delete)(?:$|[\\s"'»”)?#/.,;:!])`) },
  { id: "deny_target", re: rx(`[?&](?:action=(?:delete|remove|logout|pay|checkout)|add[-_]to[-_]cart=\\d*)`) },
];

/** ідентифікатори спрацьованих правил (без тексту); порожній масив = цитата не схожа на інструкцію до AI */
export function detectAiInstruction(text: string, extraCanaries: readonly string[] = []): string[] {
  const t = text.normalize("NFKC");
  const hit = new Set<string>();
  for (const r of AI_INSTRUCTION_RULES) if (r.re.test(t)) hit.add(r.id);
  for (const c of extraCanaries) if (c && t.toLowerCase().includes(c.toLowerCase())) hit.add("canary");
  return [...hit].sort();
}
export const looksLikeAiInstruction = (text: string, extraCanaries: readonly string[] = []): boolean => detectAiInstruction(text, extraCanaries).length > 0;
