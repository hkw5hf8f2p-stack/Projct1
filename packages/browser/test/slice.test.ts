import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSlice, detectHorizontalOverflow, serveDir, type Evidence } from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let browser: Browser;
let server: Awaited<ReturnType<typeof serveDir>>;
const tmpDirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), "sl-slice-"));
  tmpDirs.push(d);
  return d;
};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  server = await serveDir(path.join(ROOT, "fixtures/slice"));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("S1a slice: наскрізний зріз на фікстурі", () => {
  it("ПОЗИТИВ: defective.html → overflow лише на mobile + image-alt на обох viewport", async () => {
    const outDir = await tmp();
    const r = await captureSlice({ url: `${server.origin}/defective.html`, outDir, browser });

    expect(r.detector_summary.desktop.overflow.overflows).toBe(false);
    expect(r.detector_summary.mobile.overflow.overflows).toBe(true);
    expect(r.detector_summary.mobile.overflow.overflow_px).toBeGreaterThan(400);

    const byDet = (id: string, vp: string) => r.evidence.filter((e) => e.detector_id === id && e.viewport === vp);
    expect(byDet("horizontal_overflow", "mobile")).toHaveLength(1);
    expect(byDet("horizontal_overflow", "desktop")).toHaveLength(0);
    expect(byDet("axe:image-alt", "desktop")).toHaveLength(1);
    expect(byDet("axe:image-alt", "mobile")).toHaveLength(1);
    expect(r.evidence).toHaveLength(3);

    for (const e of r.evidence) {
      expect(["OBSERVED", "BENCHMARKED"]).toContain(e.source_class);
      expect(e.self_confirming).toBe(true);
      // artifact_reference відкривається і це справжній PNG; регіон лежить у межах скриншота
      const shot = path.join(outDir, e.artifact_reference);
      expect(existsSync(shot)).toBe(true);
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe("PNG");
      expect(e.selector_or_region.selector).toBeTruthy();
      expect(e.selector_or_region.region).not.toBeNull();
      expect(existsSync(path.join(outDir, e.region_artifact!))).toBe(true);
    }
    const banner = byDet("horizontal_overflow", "mobile")[0]!;
    expect(banner.selector_or_region.selector).toBe("#wide-banner");
    expect(banner.source_class).toBe("OBSERVED");
    expect(byDet("axe:image-alt", "mobile")[0]!.source_class).toBe("BENCHMARKED");
    expect(byDet("axe:image-alt", "mobile")[0]!.selector_or_region.selector).toBe("#hero-img");

    const onDisk = JSON.parse(readFileSync(path.join(outDir, "evidence.json"), "utf8")) as Evidence[];
    expect(onDisk).toHaveLength(3);
    const pa = JSON.parse(readFileSync(path.join(outDir, "page-artifact.json"), "utf8"));
    expect(existsSync(path.join(outDir, pa.desktop_screenshot))).toBe(true);
    expect(existsSync(path.join(outDir, pa.mobile_screenshot))).toBe(true);
  });

  it("НЕГАТИВ: clean.html → 0 evidence, 0 overflow, 0 axe-порушень", async () => {
    const r = await captureSlice({ url: `${server.origin}/clean.html`, outDir: await tmp(), browser });
    expect(r.evidence).toHaveLength(0);
    for (const vp of ["desktop", "mobile"] as const) {
      expect(r.detector_summary[vp].overflow.overflows).toBe(false);
      expect(r.detector_summary[vp].axe_violations).toEqual([]);
    }
  });

  it("детермінізм: 3 прогони дають ідентичний набір Evidence (id, селектор, регіон)", async () => {
    const sig = async () => {
      const r = await captureSlice({ url: `${server.origin}/defective.html`, outDir: await tmp(), browser });
      return JSON.stringify(r.evidence.map((e) => [e.id, e.detector_id, e.viewport, e.selector_or_region]));
    };
    const [a, b, c] = [await sig(), await sig(), await sig()];
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("мутант: елемент виступає, але обрізаний предком overflow-x:hidden → детектор мовчить", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.setContent(`<body style="margin:0"><div style="overflow-x:hidden;width:100%"><div style="width:900px;height:20px;background:#ccc"></div></div></body>`);
    expect((await detectHorizontalOverflow(page)).overflows).toBe(false);
    // контроль: без обрізання той самий елемент → overflow
    await page.setContent(`<body style="margin:0"><div style="width:100%"><div id="w" style="width:900px;height:20px;background:#ccc"></div></div></body>`);
    const res = await detectHorizontalOverflow(page);
    expect(res.overflows).toBe(true);
    expect(res.offenders[0]?.selector).toBe("#w");
    await context.close();
  });

  it("захоплення відмовляє нелокальному URL (SSRF-ядро — крок 3)", async () => {
    await expect(captureSlice({ url: "http://example.com/", outDir: await tmp(), browser })).rejects.toThrow(/loopback/);
  });
});
