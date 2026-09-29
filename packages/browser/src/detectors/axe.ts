import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import { evidenceId, type Evidence, type Region } from "../evidence.js";

export interface AxeSummary {
  axe_version: string;
  violations: Array<{ id: string; impact: string | null; nodes: number }>;
}

/** Запуск axe на сторінці (сторінка має бути з context, не з browser.newPage — вимога @axe-core/playwright). */
export async function runAxe(
  page: Page,
  meta: { pageUrl: string; viewport: "desktop" | "mobile"; screenshotRef: string },
): Promise<{ evidence: Evidence[]; summary: AxeSummary }> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  const evidence: Evidence[] = [];
  for (const v of result.violations) {
    for (const node of v.nodes) {
      const selector = node.target.map(String).join(" ");
      const region = await regionOf(page, selector);
      evidence.push({
        id: evidenceId("axe", v.id, meta.viewport, selector),
        type: "axe",
        // правило axe = зовнішній еталон (WCAG/best-practice), не вимір нашого коду → BENCHMARKED
        source_class: "BENCHMARKED",
        page_url: meta.pageUrl,
        self_confirming: true,
        detector_id: `axe:${v.id}`,
        claim_kind: "presence",
        viewport: meta.viewport,
        description: `${v.help} (${v.impact ?? "n/a"}): ${node.failureSummary?.split("\n").slice(0, 2).join(" ").trim() ?? ""}`,
        artifact_reference: meta.screenshotRef,
        selector_or_region: { selector, region },
        data: { rule: v.id, impact: v.impact, helpUrl: v.helpUrl, html: node.html.slice(0, 300) },
      });
    }
  }
  return {
    evidence,
    summary: {
      axe_version: result.testEngine.version,
      violations: result.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
    },
  };
}

async function regionOf(page: Page, selector: string): Promise<Region | null> {
  try {
    const box = await page.locator(selector).first().boundingBox({ timeout: 2000 });
    if (!box) return null;
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    return {
      x: Math.round(box.x + scroll.x),
      y: Math.round(box.y + scroll.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      coordinate_space: "full_page",
    };
  } catch {
    return null;
  }
}
