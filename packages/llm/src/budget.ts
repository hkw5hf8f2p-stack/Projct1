import { BudgetExceededError } from "./errors.js";

/** SPEC/FEASIBILITY §5: 1.5M вхідних + 150k вихідних, тут як єдиний ліміт сумарних токенів (DEV-40) */
export const DEFAULT_MAX_AUDIT_TOKENS = 1_650_000;

export interface BudgetEntry { call_id: string; stage: string; source: "provider" | "cache" | "fake"; input_tokens: number; output_tokens: number }

/**
 * Лічильник E4. `used` = сума токенів усіх записів (логічні токени: включно з обслуженими з кешу/replay —
 * розмір аудиту детермінований і відтворюється; реально сплачені — `billed_tokens`, з кешу — `cache_read_tokens`).
 * Перевищення неможливе: `assertCanAfford` викликається до виклику, `record` — після.
 */
export class TokenBudget {
  private entries: BudgetEntry[] = [];
  constructor(readonly max: number) {
    if (!Number.isFinite(max) || max <= 0) throw new RangeError("MAX_AUDIT_TOKENS має бути додатним числом");
  }
  get calls(): readonly BudgetEntry[] { return this.entries; }
  get input_tokens(): number { return this.entries.reduce((a, e) => a + e.input_tokens, 0); }
  get output_tokens(): number { return this.entries.reduce((a, e) => a + e.output_tokens, 0); }
  get used(): number { return this.input_tokens + this.output_tokens; }
  get cache_read_tokens(): number { return this.entries.filter((e) => e.source === "cache").reduce((a, e) => a + e.input_tokens + e.output_tokens, 0); }
  get billed_tokens(): number { return this.entries.filter((e) => e.source === "provider").reduce((a, e) => a + e.input_tokens + e.output_tokens, 0); }
  get remaining(): number { return this.max - this.used; }
  exhausted = false;

  assertCanAfford(tokens: number, what: string): void {
    if (this.used + tokens > this.max) {
      this.exhausted = true;
      throw new BudgetExceededError(`MAX_AUDIT_TOKENS: ${what} потребує ~${tokens}, залишилось ${this.remaining} з ${this.max}`, this.used, this.max);
    }
  }
  record(e: BudgetEntry): void { this.entries.push(e); }
  /** для AuditRun.config_json / UI (токени — OBSERVED, G0-24) */
  snapshot() {
    return {
      max_audit_tokens: this.max, input_tokens: this.input_tokens, output_tokens: this.output_tokens, total_tokens: this.used,
      billed_tokens: this.billed_tokens, cache_read_tokens: this.cache_read_tokens, calls: this.entries.length, exhausted: this.exhausted,
    };
  }
}
