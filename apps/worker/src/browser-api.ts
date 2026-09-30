/**
 * Єдина точка імпорту з packages/browser поза його index.ts (S1b ще доробляється іншими агентами; packages/browser не змінюємо).
 * ХУК-ЗАПИТ до sl-core-engineer: експортувати з @sitelens/browser (index.ts) audit/* і lighthouse/* та дати колбек прогресу по
 * сторінці в auditSite — тоді цей файл стане реекспортом, а копії pageIdOf/fetchRobots/pageArtifactRow — зайвими.
 */
export { captureViewport } from "../../../packages/browser/src/audit/capture-page.js";
export { crawl, normalizeCrawlUrl, CRAWL_LIMITS } from "../../../packages/browser/src/audit/crawl.js";
export { classifyPageType } from "../../../packages/browser/src/audit/classify.js";
export { detectBotProtection } from "../../../packages/browser/src/audit/botprotect.js";
export { detectAllWithCoverage, detectAxe, pageGroupOf } from "../../../packages/browser/src/audit/detectors.js";
export { assignAxeScopes, groupAxe } from "../../../packages/browser/src/audit/axe-groups.js";
export { bfsDepth } from "../../../packages/browser/src/audit/run-site.js";
export { SHIP_RE } from "../../../packages/browser/src/audit/patterns.js";
export { HostGate, HONEST_USER_AGENT, robotsPolicyFromResponse, robotsVerdict, groupFor, MIN_DELAY_MS } from "../../../packages/browser/src/audit/ethics.js";
export type { RobotsPolicy } from "../../../packages/browser/src/audit/ethics.js";
export { runLighthouseIsolated } from "../../../packages/browser/src/lighthouse/run-lighthouse.js";
export type { LighthouseRunResult, FormFactor } from "../../../packages/browser/src/lighthouse/run-lighthouse.js";
export type { PageCapture, EvidenceRow, ViewportCapture, VP } from "../../../packages/browser/src/audit/types.js";
export type { CrawlResult } from "../../../packages/browser/src/audit/crawl.js";
export type { Resolver, Dialer } from "../../../packages/browser/src/net/egress-proxy.js";
