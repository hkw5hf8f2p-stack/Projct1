// Виконується у сторінці: (patterns) => ExtractResult. Свідомо plain JS: tsx/esbuild інжектує helper `__name`,
// якого немає в контексті сторінки. Не читає жодних data-fx-*: маркери збирає окремий fx-markers.js для перевірки.
(patterns) => {
  const SHIP = new RegExp(patterns.SHIP_SRC, "iu");
  const PRICE = new RegExp(patterns.PRICE_SRC, "iu");
  const EXCL = new RegExp(patterns.PRICE_EXCL_SRC, "iu");
  const CTA = new RegExp(patterns.CTA_SRC, "iu");
  // FV = задане вікно (spec), а не innerWidth/innerHeight: на широких мобільних сторінках layout viewport розширюється
  const vw = patterns.VW;
  const vh = patterns.VH;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const de = document.documentElement;
  // на широкій мобільній сторінці layout viewport розширюється, і hit-test за координатами вікна ненадійний
  const skipCover = window.innerWidth !== vw || window.innerHeight !== vh;
  const round = (n) => Math.round(n);
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const visCache = new WeakMap();
  const visible = (el) => {
    if (visCache.has(el)) return visCache.get(el);
    let ok = true;
    try {
      ok = el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    } catch (e) {
      ok = true;
    }
    if (ok) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 1) ok = false;
      else {
        let p = el.parentElement;
        while (p && p !== de) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
            const pr = p.getBoundingClientRect();
            const ix = Math.min(r.right, pr.right) - Math.max(r.left, pr.left);
            const iy = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top);
            if (ix <= 0 || iy <= 0) {
              ok = false;
              break;
            }
          }
          p = p.parentElement;
        }
      }
    }
    visCache.set(el, ok);
    return ok;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left + sx), y: round(r.top + sy), w: round(r.width), h: round(r.height) };
  };
  const selectorOf = (el) => {
    if (el.getAttribute("id")) return "#" + CSS.escape(el.getAttribute("id"));
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== de && parts.length < 6) {
      const parent = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      if (cur.getAttribute("id")) {
        parts.unshift("#" + CSS.escape(cur.getAttribute("id")));
        break;
      }
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(cur) + 1) + ")" : tag);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const labelsText = (el) => {
    if (el.labels && el.labels.length) return norm(Array.from(el.labels).map((l) => l.textContent).join(" "));
    return "";
  };
  const accName = (el) => {
    const al = el.getAttribute("aria-label");
    if (al && norm(al)) return norm(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = norm(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" "));
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "submit" || ty === "button" || ty === "reset") return norm(el.value || el.getAttribute("value") || "");
      if (ty === "image") return norm(el.getAttribute("alt") || "");
      return labelsText(el) || norm(el.getAttribute("placeholder") || "");
    }
    if (tag === "img") return norm(el.getAttribute("alt") || "");
    const inner = norm(el.innerText || el.textContent || "");
    if (inner) return inner;
    const img = el.querySelector("img[alt]");
    if (img && norm(img.getAttribute("alt"))) return norm(img.getAttribute("alt"));
    return norm(el.getAttribute("title") || "");
  };

  // ---- links, buttons, forms
  const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({
    href: a.getAttribute("href") || "",
    abs: a.href,
    text: norm(a.innerText || a.textContent || ""),
    name: accName(a),
    visible: visible(a),
    rect: rectOf(a),
    selector: selectorOf(a),
  }));
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]')).map((b) => ({
    selector: selectorOf(b),
    name: accName(b),
    type: b.getAttribute("type") || b.tagName.toLowerCase(),
    visible: visible(b),
    rect: rectOf(b),
  }));
  const formControls = Array.from(document.querySelectorAll("input, select, textarea"))
    .filter((c) => (c.getAttribute("type") || "").toLowerCase() !== "hidden")
    .map((c) => ({
      selector: selectorOf(c),
      tag: c.tagName.toLowerCase(),
      type: c.getAttribute("type") || c.tagName.toLowerCase(),
      name: c.getAttribute("name"),
      label: labelsText(c) || norm(c.getAttribute("aria-label") || ""),
      visible: visible(c),
    }));
  const forms = Array.from(document.forms).map((f) => ({ method: (f.getAttribute("method") || "get").toLowerCase(), action: f.getAttribute("action") || "" }));

  // ---- images (img + CSS background-image видимих елементів)
  const images = [];
  for (const im of Array.from(document.images)) {
    if (!visible(im)) continue;
    images.push({
      selector: selectorOf(im),
      src: im.getAttribute("src"),
      current_src: im.currentSrc || im.src,
      alt: im.hasAttribute("alt") ? im.getAttribute("alt") : null,
      natural_w: im.naturalWidth,
      natural_h: im.naturalHeight,
      rect: rectOf(im),
      is_background: false,
    });
  }
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bg || "");
    if (m && !m[1].startsWith("data:") && visible(el)) {
      images.push({ selector: selectorOf(el), src: null, current_src: new URL(m[1], location.href).href, alt: null, natural_w: 0, natural_h: 0, rect: rectOf(el), is_background: true });
    }
  }

  // ---- видимі текстові вузли
  const textNodes = [];
  const fvParts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = norm(n.nodeValue);
    if (!t) continue;
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    if (!visible(p)) continue;
    textNodes.push({ t, a: !!p.closest("a") });
    const r = p.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) fvParts.push(t);
  }

  // ---- interactive (для CTA): vis = частка висоти у першому вікні; перекритий елемент = 0
  const interactive = [];
  for (const el of Array.from(document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"], [role="button"]'))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const name = accName(el);
    let vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / r.height;
    if (vis > 0 && !skipCover) {
      const cx = Math.min(Math.max((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, 0), vw - 1);
      const cy = Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2, 0), vh - 1);
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(top === el || el.contains(top) || top.contains(el))) vis = 0;
    }
    interactive.push({ selector: selectorOf(el), tag: el.tagName.toLowerCase(), name, rect: rectOf(el), vis: Math.round(vis * 1000) / 1000 });
  }

  // ---- ціна: найменший видимий елемент (innerText ≤ 40) з PRICE_RE; виключення — близький контекст (≤ 3 предки, ≤ 200 симв.)
  const matches = (el) => {
    const t = norm(el.innerText || "");
    return t.length > 0 && t.length <= 40 && PRICE.test(t);
  };
  const priceCandidates = [];
  const inFv = (el) => {
    const r = el.getBoundingClientRect();
    const ix = Math.min(r.right, vw) - Math.max(r.left, 0);
    const iy = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (ix <= 0 || iy <= 0) return false;
    if ((ix * iy) / (r.width * r.height) < 0.5) return false;
    if (skipCover) return true;
    const cx = Math.max(r.left, 0) + ix / 2;
    const cy = Math.max(r.top, 0) + iy / 2;
    const top = document.elementFromPoint(Math.min(cx, vw - 1), Math.min(cy, vh - 1));
    return !!top && (top === el || el.contains(top) || top.contains(el));
  };
  const excluded = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
      const t = norm(p.textContent || "");
      if (t.length <= 200 && (SHIP.test(t) || EXCL.test(t))) return true;
    }
    return false;
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IMG)$/i.test(el.tagName)) continue;
    if (!visible(el) || !matches(el)) continue;
    if (Array.from(el.children).some((c) => visible(c) && matches(c))) continue; // не найменший
    priceCandidates.push({ selector: selectorOf(el), text: norm(el.innerText), rect: rectOf(el), in_fv: inFv(el), excluded: excluded(el), kind: "text" });
  }
  for (const im of Array.from(document.images)) {
    const alt = im.getAttribute("alt");
    if (alt && visible(im) && PRICE.test(alt)) {
      priceCandidates.push({ selector: selectorOf(im), text: norm(alt), rect: rectOf(im), in_fv: inFv(im), excluded: excluded(im), kind: "img_alt" });
    }
  }

  // ---- overflow (на будь-якому viewport; предикат — у детекторі)
  const scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const scrollHeight = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const clipAncestor = (el) => {
    let p = el.parentElement;
    while (p && p !== de) {
      if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(p).overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  };
  let offenders = [];
  if (scrollWidth - de.clientWidth >= 1) {
    const cands = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > de.clientWidth + 1 && !clipAncestor(el)) cands.push({ el, r });
    }
    const deepest = cands.filter((c) => !cands.some((o) => o.el !== c.el && c.el.contains(o.el)));
    deepest.sort((a, b) => b.r.right - a.r.right || (selectorOf(a.el) < selectorOf(b.el) ? -1 : 1));
    offenders = deepest.slice(0, 3).map((c) => ({ selector: selectorOf(c.el), rect: rectOf(c.el), right: round(c.r.right + sx) }));
  }

  // ---- метадані
  const jsonld = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const walk = (o) => {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === "object") {
          if (o["@type"]) [].concat(o["@type"]).forEach((t) => jsonld.push(String(t)));
          Object.values(o).forEach(walk);
        }
      };
      walk(JSON.parse(s.textContent || "null"));
    } catch (e) {
      /* некоректний JSON-LD ігноруємо */
    }
  }
  for (const el of Array.from(document.querySelectorAll("[itemtype]"))) jsonld.push(String(el.getAttribute("itemtype")).replace(/^.*\//, ""));
  const md = document.querySelector('meta[name="description"]');
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .filter(visible)
    .map((h) => ({ level: Number(h.tagName[1]), text: norm(h.innerText || h.textContent || "") }));

  // ---- підпис макета для layout_stable
  const sig = [scrollWidth, scrollHeight];
  for (const el of Array.from(document.querySelectorAll("h1,h2,a[href],button,img,input,section,footer,header")).slice(0, 200)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    sig.push(round(r.left * 10) / 10, round(r.top * 10) / 10, round(r.width * 10) / 10, round(r.height * 10) / 10);
  }

  return {
    title: document.title,
    meta_description: md ? md.getAttribute("content") : null,
    headings,
    links,
    buttons,
    form_controls: formControls,
    forms,
    images,
    visible_text: document.body ? document.body.innerText : "",
    text_nodes: textNodes,
    fv_text: fvParts.join(" ").slice(0, 600),
    interactive,
    price_candidates: priceCandidates,
    overflow: { client_width: de.clientWidth, scroll_width: scrollWidth, scroll_height: scrollHeight, offenders },
    jsonld_types: Array.from(new Set(jsonld)).sort(),
    h1_count: headings.filter((h) => h.level === 1).length,
    signature: sig,
  };
};
