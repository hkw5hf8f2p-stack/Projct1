/** S8: matrix.json → planning/qa/sprint-5-matrix.md. Використання: tsx scripts/s8-matrix-report.ts <matrix.json> <out.md> <відносний шлях каталогу артефактів для посилань> */
import fs from "node:fs";

const [src, out, rel] = process.argv.slice(2);
if (!src || !out || !rel) throw new Error("usage: s8-matrix-report.ts <matrix.json> <out.md> <rel-dir>");
const m = JSON.parse(fs.readFileSync(src, "utf8")) as { generated_at: string; controls: any; rows: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const uk = m.rows.filter((r) => r.lang === "uk");
const en = m.rows.filter((r) => r.lang === "en");
const cnt = (rs: any[], s: string) => rs.filter((r) => r.status === s).length; // eslint-disable-line @typescript-eslint/no-explicit-any
const cellsKey = (r: any) => `${r.surface}|${r.state}`; // eslint-disable-line @typescript-eslint/no-explicit-any
const cellIds = [...new Set(uk.map(cellsKey))];
const L: string[] = [];
L.push("# Матриця станів UI (G0-19, TEST_STRATEGY §5.1) — S8", "");
L.push(`Згенеровано \`scripts/s8-matrix.ts\` + \`scripts/s8-matrix-report.ts\` на чистій копії HEAD; ${m.generated_at}. Дані: \`${rel}/matrix.json\`, скриншоти: \`${rel}/screens/\`.`, "");
const na = uk.filter((r) => r.status === "N/A");
L.push(`**Підсумок (uk):** клітинок станів ${cellIds.length} × 4 (390/1440 × light/dark) = ${uk.length}; знято й пройшло автоперевірку **${cnt(uk, "PASS")}**, FAIL **${cnt(uk, "FAIL")}**, N/A **${na.length}**. **en (completed, 1440 light):** PASS ${cnt(en, "PASS")}, FAIL ${cnt(en, "FAIL")}.`, "");
L.push("Автоперевірка кожного файлу: (1) немає горизонтального скролу на 390; (2) видимий текст — мінімальний контраст усіх видимих текстових вузлів ≥ 4.5 за обчисленими стилями (обидві теми); (3) немає `undefined`/`NaN`/`[object`/сирого JSON/сирого ключа i18n; (4) нема `pageerror`; (5) очікуваний маркер стану (`data-testid`) видимий; (6) текст не порожній; (7) для `llm_mode=none` — банер/дисклеймер; (8) en — немає кирилиці поза цитатами сайту.", "");
L.push(`**Контролі детекторів (позитивні випадки, вміють падати):** ${JSON.stringify(m.controls)}`, "");
L.push("## Межі доказу (чесно)", "");
L.push("* Стани uk відтворено на **записаних фікстурних звітах** (`SITELENS_SOURCE=fixture`, `next dev` :3100) і мутацією відповіді через `page.route` (journey-partial: stage `browser_sessions=failed`; evidence-empty: `evidence=[]`). Це доводить рендер станів UI, а не якість звіту на живому сайті.");
L.push("* «Спільні» стани: для loading і error усіх шести вкладок UI показує один і той самий екран (скелет / «звіт недоступний») — вкладка ще не змонтована. Клітинки існують і перевірені окремо (`?tab=…`), але візуально збігаються. Клітинки «✓» у §5.1 (Technical empty, Findings/Evidence partial) відтворено найближчим наявним станом (див. «Як відтворено»).");
L.push("* en-рядок: Landing і Progress — UI-рядки (fixture); Overview…Evidence і lightbox — **реальний стек** (web :3000 → api → worker, `language=en`, `llm_mode=none`, фікстура shop). en-звіт із LLM-вкладками (лінзи/журнали з текстом моделі) — ⏭️ (немає en-фікстури LLM, DEV-66).");
L.push("* Знімки — viewport (не full-page); панель активної вкладки прокручено у верх в'юпорта (для малих маркерів — так, щоб маркер був видно). Індикатор Next.js dev («N») у кутку — артефакт dev-сервера.", "");
L.push("## N/A (з причиною)", "");
for (const s of [...new Set(na.map((r) => r.surface))]) L.push(`* **${s}** (${na.filter((r) => r.surface === s).length} клітинок: ${[...new Set(na.filter((r) => r.surface === s).map((r) => r.state))].join(", ")} × 4): ${na.find((r) => r.surface === s).reason}`);
L.push("", "Інші N/A не заявлено. Комірки «—» у таблиці §5.1 (напр. Landing partial, Lightbox empty/partial) не входять у 54 і не рахуються.", "");
L.push("## Як відтворено стани", "");
L.push("| Поверхня | Стан | Як відтворено | Маркер | 1440 light | 1440 dark | 390 light | 390 dark |", "|---|---|---|---|---|---|---|---|");
const link = (r: any) => (!r ? "—" : r.status === "N/A" ? "N/A" : `[${r.status === "PASS" ? "✅" : "❌"}](${rel}/${r.file})`); // eslint-disable-line @typescript-eslint/no-explicit-any
for (const k of cellIds) {
  const rs = uk.filter((r) => cellsKey(r) === k);
  const g = (w: number, t: string) => rs.find((r) => r.width === w && r.theme === t);
  const r0 = rs[0];
  L.push(`| ${r0.surface} | ${r0.state} | ${r0.how || r0.reason || ""} | ${r0.check ? "✓" : ""} | ${link(g(1440, "light"))} | ${link(g(1440, "dark"))} | ${link(g(390, "light"))} | ${link(g(390, "dark"))} |`);
}
L.push("", "## en (completed, 1440 light)", "", "| Поверхня | Як відтворено | Результат |", "|---|---|---|");
for (const r of en) L.push(`| ${r.surface} | ${r.how} | ${link(r)}${r.failures?.length ? " " + r.failures.join("; ") : ""} |`);
const fails = m.rows.filter((r) => r.status === "FAIL");
L.push("", "## Дефекти (FAIL автоперевірки)", "");
if (!fails.length) L.push("Немає.");
for (const r of fails) L.push(`* \`${r.id}\` — ${r.failures.join("; ")} (${rel}/${r.file ?? "—"})`);
fs.writeFileSync(out, L.join("\n") + "\n");
console.log(`written ${out}`);
