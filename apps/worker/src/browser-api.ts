/**
 * Єдина точка імпорту з packages/browser у worker. Раніше — відносні імпорти в `packages/browser/src/**` (хук-запит до sl-core-engineer); тепер пакет експортує
 * audit/*, lighthouse/* і agent/* зі свого index.ts (S4), тож це тонкий реекспорт `@sitelens/browser` — без копій і без шляхів усередину пакета.
 */
export {
  captureViewport, crawl, normalizeCrawlUrl, CRAWL_LIMITS, classifyPageType, detectBotProtection, detectAllWithCoverage, detectAxe, pageGroupOf, assignAxeScopes, groupAxe,
  bfsDepth, SHIP_RE, HostGate, HONEST_USER_AGENT, robotsPolicyFromResponse, robotsVerdict, groupFor, MIN_DELAY_MS, runLighthouseIsolated,
} from "@sitelens/browser";
export type { RobotsPolicy, LighthouseRunResult, FormFactor, PageCapture, EvidenceRow, ViewportCapture, VP, CrawlResult, Resolver, Dialer } from "@sitelens/browser";
