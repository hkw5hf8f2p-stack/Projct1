/** Replay-фікстури промптів S4 (SYNTHETIC, не живий запис): запис → відтворення без провайдера, детермінізм, гучний промах. Не якість моделі (⏭️ live pass). */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordS4, SHOP_CLEAN_ARTIFACTS } from "../../../scripts/llm-replay-record-s4.js";
import { createClientFromEnv, loadPagesFromArtifacts, ReplayMissError, type PageInput } from "../src/index.js";
import { S4_NAMESPACE, productPage, runS4Sim } from "../src/testing/synthetic-s4.js";
import { REPLAY_DIR } from "./helpers.js";

const pages: PageInput[] = loadPagesFromArtifacts(SHOP_CLEAN_ARTIFACTS);
const mk = () => createClientFromEnv({ LLM_PROVIDER: "replay" }, { replayDir: REPLAY_DIR, namespace: S4_NAMESPACE });

describe("replay S4: snapshot-evaluator-v1, browser-agent-v1, finding-aggregator-v1, recommendation-v1", () => {
  it("6 записів відтворюються з кешу: усі етапи done, усі виклики source=cache (0 звернень до провайдера)", async () => {
    const { client } = mk();
    const r = await runS4Sim({ audit_run_id: "run_s4_synthetic", client, language: "uk" }, pages);
    expect([...r.snapshots, ...r.agent, r.texts].map((x) => x.status)).toEqual(Array(5).fill("done"));
    expect(client.records).toHaveLength(6);
    expect(client.records.every((c) => c.source === "cache" && c.synthetic)).toBe(true);
    expect(new Set(client.records.map((c) => c.prompt_id))).toEqual(new Set(["snapshot-evaluator-v1", "browser-agent-v1", "finding-aggregator-v1", "recommendation-v1"]));
  });
  it("змістовно: чиста лінза → no_issue без friction; швидка лінза → friction із цитатою; агент: click → stop_success; тексти без цифр", async () => {
    const { client } = mk();
    const r = await runS4Sim({ audit_run_id: "run_s4_synthetic", client, language: "uk" }, pages);
    expect(r.snapshots[0]!.output!.verdict).toBe("no_issue");
    expect(r.snapshots[0]!.output!.session.frictions).toEqual([]);
    expect(r.snapshots[1]!.output!.session.frictions).toHaveLength(1);
    expect(r.agent.map((a) => a.output!.turn.step.action)).toEqual(["click", "stop_success"]);
    expect(r.agent[0]!.output!.target).toEqual({ role: "link", name: "Доставка й оплата" });
    const t = r.texts.output!.texts["shipping|product|cost_unknown"]!;
    expect([t.title, t.problem, t.why_it_matters, t.recommended_change, t.how_to_validate].join(" ")).not.toMatch(/\p{Nd}/u);
  });
  it("детермінізм: два replay-прогони дають байт-ідентичний вихід", async () => {
    const run = async () => JSON.stringify(await runS4Sim({ audit_run_id: "run_s4_synthetic", client: mk().client, language: "uk" }, pages));
    expect(await run()).toBe(await run());
  });
  it("запис відтворюваний: перезапис у tmp = ті самі байти, що закомічені", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "s4-rec-"));
    await recordS4(tmp);
    const a = readdirSync(path.join(tmp, S4_NAMESPACE)).sort();
    expect(a).toEqual(readdirSync(path.join(REPLAY_DIR, S4_NAMESPACE)).sort());
    for (const f of a) expect(readFileSync(path.join(tmp, S4_NAMESPACE, f), "utf8")).toBe(readFileSync(path.join(REPLAY_DIR, S4_NAMESPACE, f), "utf8"));
  });
  it("зміна вмісту сторінки → ГУЧНИЙ промах (не тихий фолбек)", async () => {
    const changed = pages.map((p) => (p.page_type === "product" ? { ...p, visible_text: p.visible_text + "\nДодатковий рядок" } : p));
    expect(productPage(changed).visible_text).not.toBe(productPage(pages).visible_text);
    await expect(runS4Sim({ audit_run_id: "x", client: mk().client, language: "uk" }, changed)).rejects.toThrow(ReplayMissError);
  });
});
