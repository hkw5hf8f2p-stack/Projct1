/** Будівники доказів для тестів скорингу: кожен об'єкт проходить v3-схему `Evidence` (контракт S1a/S3). */
import { createHash } from "node:crypto";
import { Evidence } from "@sitelens/schemas";
import type { SessionObs } from "../src/index.js";

type Ev = ReturnType<typeof Evidence.parse>;
const ORIGIN = "http://shop.test";
let seq = 0;
const hid = (s: string) => "ev_" + createHash("sha256").update(s + "#" + seq++).digest("hex").slice(0, 12);

interface Base { category: Ev["category"]; claim_kind: string; path: string; page_type?: Ev["page_type"]; page_group?: string }
const CTX_OK = { banner_state: "closed" as const, banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: 200 };

export function det(b: Base & { detector_id?: string; assertion?: "presence" | "absence"; type?: Ev["type"]; source_class?: "OBSERVED" | "BENCHMARKED"; measurement?: Record<string, unknown>; viewport?: "D" | "M" }): Ev {
  return Evidence.parse({
    id: hid(`det|${b.category}|${b.claim_kind}|${b.path}`), type: b.type ?? "dom", source_class: b.source_class ?? "OBSERVED",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type ?? "product", page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, description: "detector text", artifact_reference: "pages/x.png", selector_or_region: { selector: "main" },
    detector_id: b.detector_id ?? b.claim_kind, claim_kind: b.claim_kind, assertion: b.assertion ?? "presence", viewport: b.viewport ?? "M",
    measurement: b.measurement, self_confirming: true, capture_complete: true, capture_context: CTX_OK,
  });
}

/** доказ відсутності з неповного захоплення (DEV-17/19 → ET-INC) */
export function inc(b: Base & { blocked?: number; banner_open?: boolean }): Ev {
  return Evidence.parse({
    id: hid(`inc|${b.category}|${b.claim_kind}|${b.path}`), type: "dom", source_class: "OBSERVED",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type ?? "product", page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, description: "detector text", artifact_reference: "pages/x.png", selector_or_region: { selector: "main" },
    detector_id: b.claim_kind, claim_kind: b.claim_kind, assertion: b.banner_open ? "presence" : "absence", viewport: "M",
    self_confirming: false, capture_complete: false, incomplete_reasons: [b.banner_open ? "banner_open" : "blocked_requests"],
    capture_context: { ...CTX_OK, blocked_requests_count: b.blocked ?? (b.banner_open ? 0 : 1), banner_state: b.banner_open ? "open" : "closed" },
  });
}

/** опорний факт (ET-SUP): OBSERVED без self_confirming, повне захоплення */
export function sup(b: Base): Ev {
  return Evidence.parse({
    id: hid(`sup|${b.category}|${b.claim_kind}|${b.path}`), type: "dom", source_class: "OBSERVED",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type ?? "product", page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, description: "support fact", artifact_reference: "pages/x.png", selector_or_region: { selector: "main" },
    detector_id: "support", claim_kind: b.claim_kind, assertion: "presence", viewport: "D", self_confirming: false, capture_complete: true, capture_context: CTX_OK,
  });
}

export function syn(b: Base & { session: string; lens: string; task: string; level?: "snapshot" | "journey" }): Ev {
  return Evidence.parse({
    id: hid(`syn|${b.session}|${b.category}|${b.claim_kind}|${b.path}`), type: "repeated_agent_observation", source_class: "SYNTHETIC",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type, page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, claim_kind: b.claim_kind, description: "agent note", artifact_reference: "sessions/x.json", selector_or_region: { selector: "main" },
    self_confirming: false, session_id: b.session, lens_id: b.lens, task_id: b.task, level: b.level ?? "snapshot",
  });
}

export function inf(b: Base): Ev {
  return Evidence.parse({
    id: hid(`inf|${b.category}|${b.claim_kind}|${b.path}`), type: "dom", source_class: "INFERRED",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type ?? "product", page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, claim_kind: b.claim_kind, description: "inference", artifact_reference: "pages/x.png", selector_or_region: { selector: "main" }, self_confirming: false,
  });
}

/** технічний збій браузера в журналі (ET-BRW за відтворенням або ≥ 2 журналами) */
export function brw(b: Base & { session: string; reproduced: boolean; selector?: string }): Ev {
  return Evidence.parse({
    id: hid(`brw|${b.session}|${b.path}`), type: "browser_session", source_class: "OBSERVED",
    page_url: ORIGIN + b.path, page_path: b.path, page_type: b.page_type ?? "product", page_group: b.page_group ?? (b.page_type ?? "product"),
    category: b.category, claim_kind: b.claim_kind, description: "not actionable", artifact_reference: "sessions/x.json", selector_or_region: { selector: b.selector ?? "form > button" },
    self_confirming: false, session_id: b.session, browser_failure: { kind: "not_actionable", selector: b.selector ?? "form > button", reproduced_by_replay: b.reproduced },
  });
}

export function sess(p: Partial<SessionObs> & { session_id: string; lens_id: string; task_id: string }): SessionObs {
  return { level: "snapshot", success: "true", pages_seen: [], reported_keys: [], last_friction_key: null, ...p };
}

/** детерміновані перестановки масиву (реверс, зсуви, чергування) */
export function permutations<T>(xs: readonly T[]): T[][] {
  const n = xs.length;
  const out: T[][] = [xs.slice(), xs.slice().reverse()];
  for (const k of [1, 2, 3]) out.push(xs.map((_, i) => xs[(i + k) % n] as T));
  out.push([...xs.filter((_, i) => i % 2 === 1), ...xs.filter((_, i) => i % 2 === 0)]);
  return out;
}
