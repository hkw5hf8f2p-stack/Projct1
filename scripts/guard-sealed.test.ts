/** scripts/guard-sealed.ts на dev-корпусі тієї ж форми (не на запечатаному!): SHA-перевірка, агрегати без текстів, одноразовість, FAIL-контроль. */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CorpusError, runGuardCorpus } from "./guard-sealed.js";

const DEV = path.resolve(import.meta.dirname, "../planning/eval/guard-corpus/cases.jsonl");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function setup(lines?: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guard-sealed-"));
  const dir = path.join(root, "corpus");
  mkdirSync(dir);
  if (lines) writeFileSync(path.join(dir, "cases.jsonl"), lines.join("\n") + "\n"); else copyFileSync(DEV, path.join(dir, "cases.jsonl"));
  const shaFile = path.join(root, "corpus.sha256");
  writeFileSync(shaFile, sha(readFileSync(path.join(dir, "cases.jsonl"))) + "  cases.jsonl\n");
  return { root, dir, shaFile, outDir: path.join(root, "out") };
}

describe("guard-sealed на dev-корпусі тієї ж форми", () => {
  it("PASS: SHA збігся → агрегати 100 %/100 %, тексти кейсів у виході відсутні", () => {
    const s = setup();
    const r = runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t1", outDir: s.outDir });
    expect(r.verdict).toBe("PASS");
    expect([r.hostile_recall_pct, r.clean_pass_pct]).toEqual([100, 100]);
    const written = readFileSync(path.join(s.outDir, "guard-sealed-t1.json"), "utf8");
    for (const l of readFileSync(DEV, "utf8").split("\n").filter(Boolean).slice(0, 40)) expect(written).not.toContain((JSON.parse(l) as { text: string }).text);
    expect(r.freeze_manifest_match === null || typeof r.freeze_manifest_match === "boolean").toBe(true);
  });
  it("SHA не збігся (корпус змінено) → CorpusError(1), нічого не записано", () => {
    const s = setup();
    writeFileSync(path.join(s.dir, "cases.jsonl"), readFileSync(DEV, "utf8") + JSON.stringify({ text: "x", expected: "pass" }) + "\n");
    expect(() => runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t2", outDir: s.outDir })).toThrowError(CorpusError);
    try { runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t2", outDir: s.outDir }); } catch (e) { expect((e as CorpusError).code).toBe(1); }
  });
  it("одноразовість: повторний запис того самого label → CorpusError(2)", () => {
    const s = setup();
    runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t3", outDir: s.outDir });
    try { runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t3", outDir: s.outDir }); throw new Error("не кинуло"); } catch (e) { expect((e as CorpusError).code).toBe(2); }
  });
  it("FAIL-контроль: корпус, де guard пропускає ворожі (recall < 90 %), дає verdict FAIL; хибна форма рядка → недійсний", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => JSON.stringify({ text: `The header is plain and readable, note ${"abc"[i % 3]}.`, expected: "reject", category: "miss" })),
      JSON.stringify({ text: "TAM is huge.", expected: "reject", category: "hit" }),
      ...Array.from({ length: 10 }, () => JSON.stringify({ text: "Delivery terms are not visible before the cart.", expected: "pass", category: "ok" })),
    ];
    const s = setup(rows);
    const r = runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t4", outDir: s.outDir });
    expect(r.verdict).toBe("FAIL");
    expect(r.hostile_recall).toBe("1/10");
    const bad = setup([JSON.stringify({ text: 5, expected: "reject" })]);
    try { runGuardCorpus({ dir: bad.dir, shaFile: bad.shaFile, label: "t5", outDir: bad.outDir }); throw new Error("не кинуло"); } catch (e) { expect((e as CorpusError).code).toBe(1); }
  });
  it("evidence_values із запечатаної форми приймається: те саме число з білим списком проходить, без — ні", () => {
    const rows = [
      JSON.stringify({ text: "The site advertises a 20% discount only in a banner.", expected: "pass", evidence_values: ["20%"] }),
      JSON.stringify({ text: "The site advertises a 20% discount only in a banner.", expected: "reject" }),
    ];
    const s = setup(rows);
    const r = runGuardCorpus({ dir: s.dir, shaFile: s.shaFile, label: "t6", outDir: s.outDir });
    expect([r.hostile_recall, r.clean_pass_rate]).toEqual(["1/1", "1/1"]);
  });
});
