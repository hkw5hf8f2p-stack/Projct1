/** DEV-92: семафор паралельності LLM на аудит і резерв бюджету E4 під паралельні задачі (чиста логіка, без БД/браузера). */
import { describe, expect, it } from "vitest";
import { LLM_CONCURRENCY_DEFAULT, defaultLlmConcurrency } from "@sitelens/schemas";
import { Semaphore, clampConcurrency, remainingBudget } from "../src/runtime.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function peak(limit: number, tasks: number): Promise<number> {
  const sem = new Semaphore(limit);
  let now = 0, max = 0;
  await Promise.all(Array.from({ length: tasks }, () => sem.run(async () => { now++; max = Math.max(max, now); await sleep(15); now--; })));
  expect(sem.idle).toBe(true);
  return max;
}

describe("Semaphore", () => {
  it("одночасно виконується не більше limit задач (1, 2, 3); контроль: limit=6 на 6 задачах реально дає 6", async () => {
    expect(await peak(1, 6)).toBe(1);
    expect(await peak(2, 6)).toBe(2);
    expect(await peak(3, 7)).toBe(3);
    expect(await peak(6, 6)).toBe(6);
  });
  it("виняток задачі звільняє слот (наступні не зависають)", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await sem.run(async () => 7)).toBe(7);
    expect(sem.idle).toBe(true);
  });
});

describe("налаштування паралельності", () => {
  it("clampConcurrency: 1–6, некоректне → типове 3; типове за провайдером: 3, claude_cli — 2", () => {
    expect([0, 1, 4, 6, 9, 2.5, undefined, "3"].map(clampConcurrency)).toEqual([1, 1, 4, 6, 6, LLM_CONCURRENCY_DEFAULT, LLM_CONCURRENCY_DEFAULT, LLM_CONCURRENCY_DEFAULT]);
    expect([defaultLlmConcurrency("anthropic"), defaultLlmConcurrency("openai_compatible"), defaultLlmConcurrency("claude_cli")]).toEqual([3, 3, 2]);
  });
});

describe("remainingBudget: E4 при паралельності (DEV-70 «м'який» ліміт не погіршено)", () => {
  it("формула: резерв = паралельні активні × середні токени; без даних резерв 0 (як було); мінімум 1", () => {
    expect(remainingBudget({ max: 1000, used: 400, othersActive: 0, avgCallTokens: 100 })).toBe(600);
    expect(remainingBudget({ max: 1000, used: 400, othersActive: 3, avgCallTokens: 100 })).toBe(300);
    expect(remainingBudget({ max: 1000, used: 400, othersActive: 3, avgCallTokens: null })).toBe(600);
    expect(remainingBudget({ max: 1000, used: 990, othersActive: 5, avgCallTokens: 100 })).toBe(1);
  });

  /** модель: кожна задача бере слот, рахує залишок, виконується лише якщо виклик (cost) вміщується; токени фіксуються після виклику */
  async function simulate(o: { conc: number; tasks: number; cost: number; max: number; reserve: boolean }) {
    const sem = new Semaphore(o.conc);
    let used = 0, spent = 0, skipped = 0;
    const finished: number[] = [];
    await Promise.all(Array.from({ length: o.tasks }, (_, i) => sem.run(async () => {
      const avg = o.reserve && finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : null;
      const remaining = remainingBudget({ max: o.max, used, othersActive: Math.max(0, sem.active - 1), avgCallTokens: avg });
      if (remaining < o.cost) { skipped++; return; }
      await sleep(5 + (i % 3));
      used += o.cost; spent += o.cost; finished.push(o.cost);
    })));
    return { spent, skipped };
  }

  it("з резервом сума токенів не перевищує max (після першої хвилі); без резерву (як у DEV-70) — перевищує; concurrency 1 — ніколи", async () => {
    const base = { conc: 4, tasks: 24, cost: 100, max: 550 };
    const withR = await simulate({ ...base, reserve: true });
    const noR = await simulate({ ...base, reserve: false });
    expect(withR.spent).toBeLessThanOrEqual(base.max);
    expect(noR.spent).toBeGreaterThan(base.max); // контроль: перевірка вміє впасти (старий розрахунок перевищує)
    expect((await simulate({ ...base, conc: 1, reserve: false })).spent).toBeLessThanOrEqual(base.max);
    expect(withR.skipped).toBeGreaterThan(0);
  });

  it("перша хвиля без даних: перевищення обмежене concurrency × вартість виклику (не гірше за DEV-70)", async () => {
    for (const conc of [2, 3, 6]) {
      const r = await simulate({ conc, tasks: 30, cost: 100, max: 150, reserve: true });
      expect(r.spent).toBeLessThanOrEqual(150 + (conc - 1) * 100);
    }
  });
});
