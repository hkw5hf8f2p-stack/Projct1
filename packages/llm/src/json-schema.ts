import type { ZodTypeAny } from "zod";

type J = Record<string, unknown>;
interface Def { typeName: string; [k: string]: unknown }
const def = (t: ZodTypeAny): Def => (t as unknown as { _def: Def })._def;

/**
 * Мінімальний конвертер Zod v3 → JSON Schema для структурованого виходу (tool input_schema / json_schema).
 * Підтримує лише те, що використовують LLM-схеми SiteLens; невідомий тип → помилка (жодного тихого `{}`).
 * Об'єкти: additionalProperties:false, усі неопційні ключі required. `.optional()` у LLM-схемах не використовуємо
 * (OpenAI strict вимагає required для всіх ключів) — nullable замість нього.
 */
export function zodToJsonSchema(t: ZodTypeAny): J {
  const d = def(t);
  switch (d.typeName) {
    case "ZodString": {
      const o: J = { type: "string" };
      for (const c of (d.checks as Array<{ kind: string; value?: number }>) ?? []) {
        if (c.kind === "min") o.minLength = c.value;
        if (c.kind === "max") o.maxLength = c.value;
      }
      return o;
    }
    case "ZodNumber": {
      const o: J = { type: "number" };
      for (const c of (d.checks as Array<{ kind: string; value?: number }>) ?? []) {
        if (c.kind === "int") o.type = "integer";
        if (c.kind === "min") o.minimum = c.value;
        if (c.kind === "max") o.maximum = c.value;
      }
      return o;
    }
    case "ZodBoolean": return { type: "boolean" };
    case "ZodLiteral": return { const: d.value };
    case "ZodEnum": return { type: "string", enum: d.values };
    case "ZodArray": {
      const o: J = { type: "array", items: zodToJsonSchema(d.type as ZodTypeAny) };
      const mn = d.minLength as { value: number } | null; const mx = d.maxLength as { value: number } | null;
      if (mn) o.minItems = mn.value;
      if (mx) o.maxItems = mx.value;
      return o;
    }
    case "ZodNullable": return { anyOf: [zodToJsonSchema(d.innerType as ZodTypeAny), { type: "null" }] };
    case "ZodUnion": return { anyOf: (d.options as ZodTypeAny[]).map(zodToJsonSchema) };
    case "ZodEffects": return zodToJsonSchema(d.schema as ZodTypeAny);
    case "ZodObject": {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: J = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (def(v).typeName !== "ZodOptional") required.push(k);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    default:
      throw new Error(`zodToJsonSchema: непідтримуваний тип ${d.typeName}`);
  }
}
