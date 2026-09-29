import type { Page } from "playwright";
import type { Region } from "../evidence.js";

export interface OverflowOffender {
  selector: string;
  region: Region;
  /** на скільки px правий край виступає за вікно перегляду */
  overshoot_px: number;
}

export interface OverflowResult {
  viewport_width: number;
  scroll_width: number;
  /** документ реально прокручується вбік */
  overflows: boolean;
  overflow_px: number;
  offenders: OverflowOffender[];
}

/**
 * Детектор горизонтального overflow (SPEC §53 №7, D3). Детермінований, без LLM.
 * Спрацьовує лише якщо документ справді ширший за вікно (scrollWidth > clientWidth): елементи, що виступають,
 * але обрізані предком з overflow-x != visible, не рахуються. Поріг 1 px гасить субпіксельний шум.
 */
export async function detectHorizontalOverflow(page: Page): Promise<OverflowResult> {
  return page.evaluate(IN_PAGE) as Promise<OverflowResult>;
}

// Код виконується у сторінці. Свідомо plain JS у рядку: tsx/esbuild (keepNames) інжектує helper `__name`,
// якого немає в контексті сторінки, тож серіалізація TS-функції через page.evaluate ламається.
const IN_PAGE = `(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const scrollWidth = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const TOL = 1;

    const selectorOf = (el) => {
      if (el.id) return \`#\${CSS.escape(el.id)}\`;
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && parts.length < 5) {
        const parent = cur.parentElement;
        const tag = cur.tagName.toLowerCase();
        if (cur.id) {
          parts.unshift(\`#\${CSS.escape(cur.id)}\`);
          break;
        }
        const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur.tagName) : [];
        parts.unshift(same.length > 1 ? \`\${tag}:nth-of-type(\${same.indexOf(cur) + 1})\` : tag);
        cur = parent;
      }
      return parts.join(" > ");
    };

    const clippedByAncestor = (el) => {
      let p = el.parentElement;
      while (p && p !== document.documentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== "visible") {
          const r = p.getBoundingClientRect();
          if (r.right <= vw + TOL) return true;
        }
        p = p.parentElement;
      }
      return false;
    };

    const offenders = [];
    const overflows = scrollWidth > vw + TOL;
    if (overflows) {
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + TOL && !clippedByAncestor(el)) {
          offenders.push({
            selector: selectorOf(el),
            region: {
              x: Math.round(r.left + window.scrollX),
              y: Math.round(r.top + window.scrollY),
              width: Math.round(r.width),
              height: Math.round(r.height),
              coordinate_space: "full_page",
            },
            overshoot_px: Math.round(r.right - vw),
          });
        }
      }
      // лишаємо «кореневі» порушники: без предка, що теж порушник (за селектором-префіксом ширини не судимо — просто топ за виступом)
      offenders.sort((a, b) => b.overshoot_px - a.overshoot_px || a.selector.localeCompare(b.selector));
    }
    return { viewport_width: vw, scroll_width: scrollWidth, overflows, overflow_px: Math.max(0, scrollWidth - vw), offenders: offenders.slice(0, 5) };
})()`;
