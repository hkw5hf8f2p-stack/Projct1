import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAxe } from "./detectors/axe.js";
import { detectHorizontalOverflow } from "./detectors/overflow.js";
import { evidenceId, type Evidence } from "./evidence.js";
import { assertSecureBrowser, type SecureBrowser } from "./secure-launch.js";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export interface SliceResult {
  page_artifact: Record<string, unknown>;
  evidence: Evidence[];
  detector_summary: Record<ViewportName, { overflow: { overflows: boolean; overflow_px: number; offenders: number }; axe_violations: Array<{ id: string; impact: string | null; nodes: number }> }>;
}

/**
 * Мінімальний наскрізний зріз S1a крок 2: одна URL → 2 viewport → скриншоти → axe + overflow → Evidence.
 * Лише локальна фікстура. Браузер — лише `SecureBrowser` (результат secureLaunch: egress-проксі, шар 2 не-GET/WS,
 * пісочниця без фолбеку, очищений env; G0-3, G0-4). Сирий playwright Browser — помилка типу й runtime-виняток.
 */
export async function captureSlice(opts: { url: string; outDir: string; secure: SecureBrowser }): Promise<SliceResult> {
  const { url, outDir } = opts;
  assertSecureBrowser(opts.secure, "captureSlice");
  if (!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) throw new Error("captureSlice (крок 2) приймає лише loopback-фікстуру; SSRF-ядро — крок 3");
  await mkdir(path.join(outDir, "screenshots"), { recursive: true });
  await mkdir(path.join(outDir, "regions"), { recursive: true });

  const secure = opts.secure;
  const evidence: Evidence[] = [];
  const detector_summary = {} as SliceResult["detector_summary"];
  const shots: Record<string, string> = {};
  let title = "";
  let status: number | null = null;

  try {
    for (const name of Object.keys(VIEWPORTS) as ViewportName[]) {
      const vp = VIEWPORTS[name];
      const context = await secure.newContext({ viewport: vp });
      try {
        const page = await context.newPage();
        const resp = await page.goto(url, { waitUntil: "load" });
        status = resp?.status() ?? status;
        title = await page.title();

        const base = `${name}-${vp.width}x${vp.height}`;
        const viewportShot = `screenshots/${base}-viewport.png`;
        const fullShot = `screenshots/${base}-full.png`;
        await page.screenshot({ path: path.join(outDir, viewportShot) });
        await page.screenshot({ path: path.join(outDir, fullShot), fullPage: true });
        shots[name] = fullShot;

        // overflow
        const of = await detectHorizontalOverflow(page);
        if (of.overflows) {
          for (const off of of.offenders) {
            const cropRef = `regions/${name}-overflow-${evidenceId(off.selector).slice(3)}.png`;
            await cropRegion(page, path.join(outDir, cropRef), off.region, vp.width);
            evidence.push({
              id: evidenceId("horizontal_overflow", name, off.selector),
              type: "dom",
              source_class: "OBSERVED", // виміряно в DOM цього прогону, без зовнішнього еталона
              page_url: url,
              self_confirming: true,
              detector_id: "horizontal_overflow",
              claim_kind: "presence",
              viewport: name,
              description: `Сторінка прокручується вбік на ${vp.width}px: scrollWidth ${of.scroll_width}px > вікно ${of.viewport_width}px; елемент виступає на ${off.overshoot_px}px.`,
              artifact_reference: fullShot,
              selector_or_region: { selector: off.selector, region: off.region },
              region_artifact: cropRef,
              data: { viewport_width: of.viewport_width, scroll_width: of.scroll_width, overshoot_px: off.overshoot_px },
            });
          }
        }

        // axe
        const ax = await runAxe(page, { pageUrl: url, viewport: name, screenshotRef: fullShot });
        for (const e of ax.evidence) {
          if (e.selector_or_region.region) {
            const cropRef = `regions/${name}-${e.detector_id.replace(/\W/g, "_")}-${e.id.slice(3)}.png`;
            await cropRegion(page, path.join(outDir, cropRef), e.selector_or_region.region, vp.width);
            e.region_artifact = cropRef;
          }
          evidence.push(e);
        }
        detector_summary[name] = {
          overflow: { overflows: of.overflows, overflow_px: of.overflow_px, offenders: of.offenders.length },
          axe_violations: ax.summary.violations,
        };
      } finally {
        await context.close();
      }
    }
  } finally {
    // secure принадлежить викликачу (він і закриває)
  }

  evidence.sort((a, b) => a.id.localeCompare(b.id));
  const page_artifact = {
    // форма рядка PageArtifact, SPEC §8 (частина полів — S2, коли з'явиться БД)
    id: evidenceId("page", url),
    audit_run_id: null,
    url,
    page_type: "fixture",
    title,
    http_status: status,
    desktop_screenshot: shots.desktop,
    mobile_screenshot: shots.mobile,
    technical_json: { browser_version: secure.browser.version(), viewports: VIEWPORTS, detector_summary },
  };
  await writeFile(path.join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(path.join(outDir, "page-artifact.json"), JSON.stringify(page_artifact, null, 2) + "\n");
  return { page_artifact, evidence, detector_summary };
}

async function cropRegion(page: import("playwright").Page, file: string, r: { x: number; y: number; width: number; height: number }, vpWidth: number) {
  const pad = 8;
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  // широкі регіони (overflow) обрізаємо до 2× вікна, щоб файл був малий
  const width = Math.max(1, Math.min(r.width + 2 * pad, vpWidth * 2));
  const height = Math.max(1, Math.min(r.height + 2 * pad, 400));
  await page.screenshot({ path: file, fullPage: true, clip: { x, y, width, height } });
}
