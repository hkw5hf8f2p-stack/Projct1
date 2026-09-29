/**
 * Одноразовий генератор растрових зображень фікстур (JPEG через canvas Chromium; запускати від sitelens).
 * Результати закомічені в fixtures (папки img) — скрипт лише документує, як вони зроблені.
 *   bash scripts/run-as-sitelens.sh env OUT_DIR=/tmp/sl-img pnpm exec tsx scripts/make-fixture-images.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT = process.env.OUT_DIR ?? "/tmp/sl-img";
mkdirSync(OUT, { recursive: true });

const GEN = `(async (spec) => {
  const c = document.createElement("canvas");
  c.width = spec.w; c.height = spec.h;
  const g = c.getContext("2d");
  g.fillStyle = spec.c1; g.fillRect(0, 0, spec.w, spec.h);
  g.fillStyle = spec.c2; g.fillRect(0, spec.h * 0.55, spec.w, spec.h * 0.45);
  let s = spec.seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 6; i++) { g.fillStyle = ["#ebf8ff", "#fefcbf", "#e6fffa"][i % 3]; g.fillRect(rnd()*spec.w*0.8, rnd()*spec.h*0.6, spec.w*0.12, spec.h*0.25); }
  if (spec.noise > 0) {
    const img = g.getImageData(0, 0, spec.w, spec.h); const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * spec.noise; d[i] += n; d[i+1] += n; d[i+2] += n; }
    g.putImageData(img, 0, 0);
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", spec.q));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
})`;

const specs = [
  { name: "hero-large.jpg", w: 2400, h: 1600, c1: "#2b6cb0", c2: "#38b2ac", seed: 7, noise: 0, q: 0.9, padTo: 1_700_000 },
  { name: "hero-small.jpg", w: 1440, h: 480, c1: "#2b6cb0", c2: "#38b2ac", seed: 7, noise: 0, q: 0.5 },
  { name: "clean-hero.jpg", w: 1440, h: 480, c1: "#b7791f", c2: "#dd6b20", seed: 11, noise: 0, q: 0.5 },
];

/**
 * Доводить JPEG до заданого розміру службовими COM-сегментами (валідний JPEG, зображення не змінюється): «важкий» файл
 * за байтами без шумного вмісту, що роздував би скриншоти артефактів (PNG шуму ~1 МБ). Детектор №8 міряє лише байти.
 */
function padJpeg(jpeg: Buffer, target: number): Buffer {
  const chunks: Buffer[] = [];
  let total = jpeg.length;
  let seed = 12345;
  while (total < target) {
    const data = Buffer.alloc(Math.min(65533, target - total > 4 ? Math.max(1, target - total - 4) : 1));
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = 0x20 + ((seed >>> 24) % 90); // друковані ASCII, без 0xFF
    }
    const head = Buffer.from([0xff, 0xfe, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff]);
    chunks.push(head, data);
    total += head.length + data.length;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...chunks, jpeg.subarray(2)]);
}

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const page = await (await browser.newContext()).newPage();
  for (const s of specs) {
    const b64 = (await page.evaluate(`${GEN}(${JSON.stringify(s)})`)) as string;
    let buf: Buffer = Buffer.from(b64, "base64");
    if (s.padTo) buf = padJpeg(buf, s.padTo);
    writeFileSync(path.join(OUT, s.name), buf);
    console.log(s.name, buf.length);
  }
} finally {
  await browser.close();
}
