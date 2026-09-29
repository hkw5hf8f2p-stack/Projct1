/**
 * Тайлінг для LLM (D4): перше вікно (viewport.png) + тайли висотою вікна з перекриттям 15 % — full-page скриншот
 * моделі не віддається. Тайли покривають сторінку від (vh − overlap) донизу; файли JPEG (компактні) + manifest.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { TilesManifest, ViewportSpec, VP } from "./types.js";

export const TILE_OVERLAP_RATIO = 0.15;

export function planTiles(fullHeight: number, vh: number, overlap: number): Array<{ y: number; h: number }> {
  const out: Array<{ y: number; h: number }> = [];
  if (fullHeight <= vh) return out;
  const step = vh - overlap;
  for (let y = step; ; y += step) {
    const h = Math.min(vh, fullHeight - y);
    out.push({ y, h });
    if (y + vh >= fullHeight) break;
  }
  return out;
}

export async function tileFullPage(
  page: Page,
  o: { vp: VP; spec: ViewportSpec; runDir: string; dirRel: string; viewportRef: string; fullHeight: number; fullWidth: number; write: boolean },
): Promise<TilesManifest> {
  const overlap = Math.round(o.spec.height * TILE_OVERLAP_RATIO);
  const plan = planTiles(o.fullHeight, o.spec.height, overlap);
  const tiles: TilesManifest["tiles"] = [];
  if (o.write) await mkdir(path.join(o.runDir, o.dirRel, "tiles"), { recursive: true });
  for (const [i, t] of plan.entries()) {
    const file = `${o.dirRel}/tiles/tile-${String(i + 1).padStart(2, "0")}.jpg`;
    if (o.write) {
      await page.screenshot({ path: path.join(o.runDir, file), type: "jpeg", quality: 75, fullPage: true, clip: { x: 0, y: t.y, width: o.fullWidth, height: t.h }, animations: "disabled", caret: "hide" });
    }
    tiles.push({ index: i + 1, file, y_css: t.y, height_css: t.h });
  }
  const manifest: TilesManifest = {
    viewport: o.vp,
    first_viewport: o.viewportRef,
    tile_height_css: o.spec.height,
    overlap_css: overlap,
    full_height_css: o.fullHeight,
    width_css: o.fullWidth,
    dpr: o.spec.dpr,
    tiles,
  };
  if (o.write) await writeFile(path.join(o.runDir, o.dirRel, "tiles", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
