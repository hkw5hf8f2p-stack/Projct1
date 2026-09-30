/**
 * Генерує контракт звіту (S4 «день 1»): `packages/schemas/report.schema.json` (JSON Schema з Zod) і
 * `packages/schemas/examples/report.fixture.json` (приклад для UI S5: артефакти sprint-1a-fix/shop + ПРИКЛАДНІ LLM-дані,
 * provenance=example_fixture). Тести дрейфу (`packages/schemas/test/report-contract.test.ts`,
 * `packages/reporting/test/build-report.test.ts`) падають, якщо файли не перегенеровано.
 * Запуск: `pnpm exec tsx scripts/gen-report-contract.ts`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { reportJsonSchema } from "../packages/schemas/src/index.js";
import { exampleReport } from "../packages/reporting/src/testing/example-report.js";
import { REPO_ROOT } from "./artifact-dir.js";

const out = (rel: string, v: unknown) => {
  writeFileSync(path.join(REPO_ROOT, rel), JSON.stringify(v, null, 2) + "\n");
  console.log("wrote", rel);
};
out("packages/schemas/report.schema.json", reportJsonSchema());
out("packages/schemas/examples/report.fixture.json", exampleReport());
