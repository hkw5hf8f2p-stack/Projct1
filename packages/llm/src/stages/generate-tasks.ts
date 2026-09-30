import { Task, TASK_TYPES } from "@sitelens/schemas";
import { taskGeneratorV1 } from "../../prompts/task-generator-v1.js";
import { findInjectionEcho, findInventedNumbers, findUnknownRequired, findWrongLanguage, type Issue, norm } from "../guards/text.js";
import { pageCorpus, wrapDerivedData, type PageInput } from "../page-input.js";
import { TasksLlm, type SiteProfileCore } from "../schemas.js";
import { buildRequest, LANG_NAME } from "./prompt-util.js";
import { profileStrings } from "./build-site-profile.js";
import { done, guardStage, type StageContext, type StageResult } from "./types.js";

/** Задача не може вимагати заборонених дій §20 (оплата, реєстрація, повідомлення, форма) */
const FORBIDDEN_TASK = /(?<![\p{L}\p{N}])(?:pay(?:ment)?|checkout and pay|create an? account|sign ?up|register|send (?:a )?message|submit (?:the |a )?(?:contact )?form|log ?in|оплат\p{L}*|сплат\p{L}*|зареєструв\p{L}*|створ\p{L}* акаунт\p{L}*|надіслат\p{L}* повідомлення|заповн\p{L}* форм\p{L}*|увійти)(?![\p{L}\p{N}])/iu;

export function validateTasks(v: TasksLlm, pages: readonly PageInput[], profile: SiteProfileCore, lang: "uk" | "en"): Issue[] {
  const out: Issue[] = [];
  const ids = new Set(pages.map((p) => p.id));
  const seen = new Set<string>();
  for (const t of v.tasks) {
    if (seen.has(t.task_id)) out.push(`duplicate_id: task_id ${t.task_id} повторюється`);
    seen.add(t.task_id);
    if (!ids.has(t.recommended_start_page)) out.push(`dangling_reference: recommended_start_page «${t.recommended_start_page}» — немає такої сторінки`);
  }
  if (!v.tasks.some((t) => t.is_primary_goal)) out.push("missing_primary_goal_task: жодна задача не відповідає primary_conversion_goal");
  const corpus = pages.map(pageCorpus).join("\n") + "\n" + norm(profileStrings(profile).join("\n"));
  const strings = v.tasks.flatMap((t) => [t.name, t.goal, ...t.success_conditions, ...t.failure_conditions]);
  out.push(...findUnknownRequired(Object.fromEntries(v.tasks.flatMap((t) => [[`${t.task_id}.name`, t.name], [`${t.task_id}.goal`, t.goal]]))));
  out.push(...findInventedNumbers(strings, corpus));
  out.push(...findInjectionEcho(strings));
  out.push(...findWrongLanguage(strings, lang));
  for (const t of v.tasks) {
    const m = FORBIDDEN_TASK.exec([t.name, t.goal, ...t.success_conditions].join(" "));
    if (m) out.push(`forbidden_action: задача ${t.task_id} вимагає забороненої дії «${m[0]}» (§20)`);
  }
  return out;
}

export async function generateTasks(ctx: StageContext, input: { pages: readonly PageInput[]; profile: SiteProfileCore }): Promise<StageResult<{ tasks: Task[]; prompt_id: string }>> {
  return guardStage("tasks", taskGeneratorV1.id, ctx, async () => {
    const pageList = input.pages.map((p) => `${p.id}\t${p.page_type}\t${p.url}`).join("\n");
    const req = buildRequest({
      stage: "tasks", prompt: taskGeneratorV1, max_tokens: 3000,
      vars: { LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], TASK_TYPES: TASK_TYPES.join(", "), PAGE_LIST: pageList, PROFILE_DATA: wrapDerivedData(JSON.stringify(input.profile, null, 1)) },
      logical: { step: 0 },
    });
    const r = await ctx.client.call(req, TasksLlm, (v) => validateTasks(v, input.pages, input.profile, ctx.language));
    const urlOf = new Map(input.pages.map((p) => [p.id, p.url]));
    const tasks = r.value.tasks.map((t) => Task.parse({ ...t, recommended_start_page: urlOf.get(t.recommended_start_page), audit_run_id: ctx.audit_run_id }));
    return done("tasks", taskGeneratorV1.id, { tasks, prompt_id: taskGeneratorV1.id }, r.calls);
  });
}
