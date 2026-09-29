// Виконується у сторінці: (patterns, parsePrices) => ExtractResult. Свідомо plain JS: tsx/esbuild інжектує helper `__name`,
// якого немає в контексті сторінки. Службових міток фікстури не читає: їх збирає окремий скрипт для перевірки.
(patterns, parsePrices) => {
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
  const skipCover = window.innerWidth !== vw || window.innerHeight !== vh || de.scrollWidth > de.clientWidth + 1;
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


  // ---- орієнтири (landmarks), групи карток K1, ціни (page-type-spec §2). Жодних назв/класів/шляхів фікстур: лише структура.
  const EXC = "header, nav, footer, aside, [role=banner], [role=navigation], [role=contentinfo]";
  const mainEl = document.querySelector("main, [role=main]");
  const lmCache = new WeakMap();
  const kindOf = (ex) => {
    const t = ex.tagName.toLowerCase();
    const r = (ex.getAttribute("role") || "").toLowerCase();
    if (t === "nav" || r === "navigation") return "nav";
    if (t === "header" || r === "banner") return "header";
    if (t === "footer" || r === "contentinfo") return "footer";
    return "aside";
  };
  const landmarkOf = (el) => {
    if (lmCache.has(el)) return lmCache.get(el);
    let res;
    const ex = el.closest(EXC);
    if (ex && !(mainEl && mainEl.contains(ex))) res = kindOf(ex);
    else if (mainEl) res = mainEl.contains(el) ? "main" : "other";
    else res = "main";
    lmCache.set(el, res);
    return res;
  };
  const selfUrl = (() => {
    try {
      const u = new URL(location.href);
      u.hash = "";
      return u.origin + (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname) + u.search;
    } catch (e) {
      return "";
    }
  })();
  const normUrl = (href) => {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return null;
      return u.origin + (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname) + u.search;
    } catch (e) {
      return null;
    }
  };
  const sigOf = (el, d) => {
    let out = "";
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      if (/^(script|style|noscript|template)$/.test(t) || !visible(c)) continue;
      out += t + (d > 1 ? "(" + sigOf(c, d - 1) + ")" : "") + ",";
    }
    return out;
  };
  const cardInfo = (n) => {
    if (!visible(n)) return null;
    const r = n.getBoundingClientRect();
    if (r.width < 40 || r.height < 30 || r.height > 1.2 * vh || (n.textContent || "").length > 1500) return null; // картка — невеликий блок
    const anchors = n.matches("a[href]") ? [n] : [];
    for (const a of n.querySelectorAll("a[href]")) anchors.push(a);
    if (anchors.length === 0) return null;
    const urls = [];
    let primary = null;
    for (const a of anchors) {
      if (!visible(a)) continue;
      const u = normUrl(a.href);
      if (u && u !== selfUrl) {
        if (!primary) primary = a;
        if (!urls.includes(u)) urls.push(u);
      }
    }
    if (!urls.length) return null;
    let img = false;
    for (const im of n.querySelectorAll("img")) {
      if (!visible(im)) continue;
      const ir = im.getBoundingClientRect();
      if (ir.width * ir.height >= 2500) {
        img = true;
        break;
      }
    }
    const price = parsePrices(norm(n.innerText || "")).length > 0;
    if (!img && !price) return null;
    return { n, r, urls, img, price, primary };
  };
  const groupsRaw = [];
  const considerPool = (pool) => {
    const infos = [];
    for (const n of pool) {
      if (landmarkOf(n) !== "main") continue;
      if (!n.querySelector("a[href]") && !n.matches("a[href]")) continue;
      const i = cardInfo(n);
      if (i) infos.push(i);
    }
    if (infos.length < 2) return;
    const by = new Map();
    for (const i of infos) {
      const k = i.n.tagName.toLowerCase() + "(" + sigOf(i.n, 3) + ")";
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(i);
    }
    for (const [sig, arr] of by) {
      if (arr.length < 2) continue;
      const ws = arr.map((i) => i.r.width).sort((a, b) => a - b);
      const med = ws[Math.floor(ws.length / 2)];
      const ok = arr.filter((i) => Math.abs(i.r.width - med) <= 0.2 * med);
      if (ok.length < 2) continue;
      const keys = new Set(ok.map((i) => i.urls.slice().sort().join("|")));
      if (keys.size !== ok.length) continue;
      groupsRaw.push({ sig, ok });
    }
  };
  {
    let seenEls = 0;
    for (const P of Array.from(document.body.querySelectorAll("*"))) {
      if (++seenEls > 4000) break;
      if (P.children.length < 2 && !(P.children.length === 1 && P.children[0].children.length >= 2)) continue;
      if (landmarkOf(P) !== "main" || !visible(P)) continue;
      considerPool(Array.from(P.children));
      const cousins = [];
      for (const c of P.children) for (const g of c.children) cousins.push(g);
      if (cousins.length >= 2) considerPool(cousins);
    }
  }
  // дедуплікація: однакові набори й вкладені групи (лишаємо зовнішні «картки»)
  const sameNodes = (a, b) => a.ok.length === b.ok.length && a.ok.every((i) => b.ok.some((j) => j.n === i.n));
  const inside = (g, h) => g.ok.every((i) => h.ok.some((j) => j.n === i.n || j.n.contains(i.n)));
  const groupsDedup = [];
  for (const g of groupsRaw) {
    if (groupsDedup.some((h) => sameNodes(g, h))) continue;
    groupsDedup.push(g);
  }
  const groupsFinal = groupsDedup.filter((g) => !groupsDedup.some((h) => h !== g && !sameNodes(g, h) && inside(g, h)));
  const cardSet = new Set();
  const cardPrimary = new Set();
  for (const g of groupsFinal) for (const i of g.ok) {
    cardSet.add(i.n);
    if (i.primary) cardPrimary.add(i.primary);
  }
  const inCard = (el) => {
    for (let p = el; p && p !== de; p = p.parentElement) if (cardSet.has(p)) return true;
    return false;
  };
  const cardGroups = groupsFinal
    .map((g) => {
      const rects = g.ok.map((i) => rectOf(i.n));
      const x0 = Math.min(...rects.map((r) => r.x));
      const y0 = Math.min(...rects.map((r) => r.y));
      const x1 = Math.max(...rects.map((r) => r.x + r.w));
      const y1 = Math.max(...rects.map((r) => r.y + r.h));
      return {
        signature: g.sig.length > 160 ? g.sig.slice(0, 160) : g.sig,
        count: g.ok.length,
        rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        nodes: rects,
        with_img: g.ok.filter((i) => i.img).length,
        with_price: g.ok.filter((i) => i.price).length,
        urls: g.ok.map((i) => i.urls[0]),
        names: g.ok.map((i) => norm((i.n.querySelector("h1,h2,h3,h4,h5,h6") || i.primary || i.n).innerText || "").slice(0, 80)),
      };
    })
    .sort((a, b) => a.rect.y - b.rect.y || b.count - a.count);

  // ---- links, buttons, forms
  const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({
    href: a.getAttribute("href") || "",
    abs: a.href,
    text: norm(a.innerText || a.textContent || ""),
    name: accName(a),
    visible: visible(a),
    rect: rectOf(a),
    selector: selectorOf(a),
    landmark: landmarkOf(a),
    in_card: inCard(a),
    card_primary: cardPrimary.has(a),
    has_counter: Array.from(a.querySelectorAll("*")).some((c) => c.children.length === 0 && /^\d{1,3}$/.test(norm(c.textContent)) && visible(c)),
  }));
  const navTargets = new Set();
  for (const l of links) if (l.visible && (l.landmark === "header" || l.landmark === "nav" || l.landmark === "footer")) navTargets.add(normUrl(l.abs));
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
      landmark: landmarkOf(im),
      in_card: inCard(im),
    });
  }
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bg || "");
    if (m && !m[1].startsWith("data:") && visible(el)) {
      images.push({ selector: selectorOf(el), src: null, current_src: new URL(m[1], location.href).href, alt: null, natural_w: 0, natural_h: 0, rect: rectOf(el), is_background: true, landmark: landmarkOf(el), in_card: inCard(el) });
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
  const alphaOf = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return c === "transparent" ? 0 : 1;
    const p = m[1].split(/[ ,/]+/).filter(Boolean);
    return p.length >= 4 ? Number(p[3]) : 1;
  };
  for (const el of Array.from(document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"], input[type="image"], [role="button"]'))) {
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
    const cs = getComputedStyle(el);
    const f = el.closest("form");
    const isA = el.tagName === "A";
    interactive.push({
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      name,
      rect: rectOf(el),
      vis: Math.round(vis * 1000) / 1000,
      role: el.getAttribute("role"),
      input_type: el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : null,
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      is_link: isA,
      href: isA ? el.href : null,
      nav_target: isA && navTargets.has(normUrl(el.href)),
      bg_opaque: alphaOf(cs.backgroundColor) >= 0.5 || (cs.backgroundImage && cs.backgroundImage !== "none"),
      border: ["Top", "Right", "Bottom", "Left"].some((sd) => parseFloat(cs["border" + sd + "Width"]) >= 1 && cs["border" + sd + "Style"] !== "none" && alphaOf(cs["border" + sd + "Color"]) > 0),
      pad_y: Math.min(parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0),
      pad_x: Math.min(parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0),
      font_size: parseFloat(cs.fontSize) || 0,
      landmark: landmarkOf(el),
      in_card: inCard(el),
      form: f
        ? {
            method: (f.getAttribute("method") || "get").toLowerCase(),
            free_text: Array.from(f.querySelectorAll("textarea, input")).some((i) => visible(i) && (i.tagName === "TEXTAREA" || /^(text|email|tel|password|search|url)$/.test((i.getAttribute("type") || "text").toLowerCase()))),
            has_variants: !!f.querySelector("select, input[type=radio], input[type=number]"),
          }
        : null,
    });
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


  // ---- узагальнені ціни (парсер валют), рядки кошика, ознаки форм/інфо (spec §2)
  const prices = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IMG|OPTION|SELECT)$/i.test(el.tagName)) continue;
    if ((el.textContent || "").length > 120 || !visible(el)) continue;
    const t = norm(el.innerText || "");
    if (!t || t.length > 60) continue;
    const found = parsePrices(t);
    if (!found.length) continue;
    if (Array.from(el.children).some((c) => visible(c) && parsePrices(norm(c.innerText || "")).length > 0)) continue;
    const cs = getComputedStyle(el);
    prices.push({ selector: selectorOf(el), value: found[0].value, currency: found[0].currency, text: found[0].text, rect: rectOf(el), font_size: parseFloat(cs.fontSize) || 0, font_weight: Number(cs.fontWeight) || 400, in_card: inCard(el), landmark: landmarkOf(el), prefix_from: found[0].prefix_from });
    if (prices.length >= 300) break;
  }
  const isQty = (c) => {
    const ty = (c.getAttribute("type") || "").toLowerCase();
    if (c.tagName === "INPUT" && ty === "number") return true;
    if (c.tagName === "INPUT" && /qty|quant|amount|kilk|ilosc|ilość/i.test(c.getAttribute("name") || "")) return true;
    if (c.tagName === "SELECT") {
      const o = Array.from(c.options).slice(0, 6);
      return o.length >= 2 && o.every((x) => /^\d+$/.test(x.text.trim()));
    }
    if (c.tagName === "BUTTON" || c.getAttribute("role") === "button") return /^[+−–-]$/.test(accName(c));
    return false;
  };
  const isRemove = (c) => /(^|\s)(remove|delete|видалити|прибрати|usuń|usun)|[×✕✖]/i.test(accName(c));
  const cartRows = [];
  const rowSeen = new Set();
  for (const c of Array.from(document.querySelectorAll("input, select, button, [role=button], a[href]"))) {
    if (!visible(c) || landmarkOf(c) !== "main" || inCard(c)) continue;
    const qty = isQty(c);
    const rem = !qty && isRemove(c);
    if (!qty && !rem) continue;
    const row = c.closest("tr, li, [role=row]");
    if (!row || rowSeen.has(row) || inCard(row)) continue;
    rowSeen.add(row);
    const pr = parsePrices(norm(row.innerText || ""))[0];
    if (!pr) continue;
    const ctl = Array.from(row.querySelectorAll("input, select, button, [role=button], a[href]")).filter(visible);
    cartRows.push({ price: pr.value, rect: rectOf(row), has_qty: ctl.some(isQty), has_remove: ctl.some((x) => !isQty(x) && isRemove(x)) });
  }
  const acTokens = [];
  for (const i of Array.from(document.querySelectorAll("input, select, textarea"))) {
    const ac = (i.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter((t) => t && t !== "on" && t !== "off");
    if (ac.length && visible(i)) acTokens.push(ac[ac.length - 1]);
  }
  const vhVisible = (e) => visible(e);
  const detailsCount = Array.from(document.querySelectorAll("details > summary")).filter(vhVisible).length;
  const questionHeadings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h) => vhVisible(h) && /\?\s*$/.test(norm(h.innerText || ""))).length;
  const shipParagraphs = Array.from(document.querySelectorAll("p")).filter((p) => vhVisible(p) && landmarkOf(p) === "main" && SHIP.test(norm(p.innerText || ""))).length;
  const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const h1El = Array.from(document.querySelectorAll("h1")).find(vhVisible) || null;
  let mainRect;
  if (mainEl) mainRect = rectOf(mainEl);
  else {
    let top = 0;
    let bottom = docH;
    for (const e of Array.from(document.querySelectorAll("header, [role=banner], nav, [role=navigation]"))) {
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.top + sy < 300) top = Math.max(top, r.bottom + sy);
    }
    for (const e of Array.from(document.querySelectorAll("footer, [role=contentinfo]"))) {
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.top + sy > docH / 2) bottom = Math.min(bottom, r.top + sy);
    }
    mainRect = { x: 0, y: round(top), w: de.clientWidth, h: Math.max(0, round(bottom - top)) };
  }
  const relNext = !!document.querySelector('link[rel~="next"], link[rel~="prev"], a[rel~="next"]');
  const pageLinks = links.some((l) => l.visible && l.landmark === "main" && /[?&](page|p)=\d+|\/page\/\d+/i.test(l.abs));
  const firstGroupY = cardGroups.length ? cardGroups[0].rect.y : Infinity;
  const sortSel = Array.from(document.querySelectorAll("select")).some((s) => vhVisible(s) && landmarkOf(s) === "main" && s.options.length >= 3 && s.getBoundingClientRect().top + sy < firstGroupY);
  const listingControls = relNext || pageLinks || (cardGroups.length > 0 && sortSel);
  const ogEl = document.querySelector('meta[property="og:type"], meta[name="og:type"]');
  const canonEl = document.querySelector('link[rel~="canonical"]');

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
  const jsonldTop = [];
  const LISTY = /^(ItemList|CollectionPage|OfferCatalog|SearchResultsPage|ProductCollection)$/i;
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const walk = (o, under) => {
        if (Array.isArray(o)) o.forEach((x) => walk(x, under));
        else if (o && typeof o === "object") {
          const types = o["@type"] ? [].concat(o["@type"]).map(String) : [];
          types.forEach((t) => jsonld.push(t));
          if (!under) types.forEach((t) => jsonldTop.push(t));
          const listy = types.some((t) => LISTY.test(t));
          for (const k of Object.keys(o)) if (k !== "@type") walk(o[k], under || listy);
        }
      };
      walk(JSON.parse(s.textContent || "null"), false);
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
    og_type: ogEl ? (ogEl.getAttribute("content") || "").trim().toLowerCase() || null : null,
    canonical: canonEl ? canonEl.href : null,
    jsonld_top: Array.from(new Set(jsonldTop)),
    microdata_types: Array.from(document.querySelectorAll("[itemtype]")).map((el) => ({ type: String(el.getAttribute("itemtype")).replace(/^.*\//, ""), in_card: inCard(el) })),
    h1_rect: h1El ? rectOf(h1El) : null,
    main_rect: mainRect,
    card_groups: cardGroups,
    prices,
    autocomplete_tokens: acTokens,
    details_count: detailsCount,
    question_headings: questionHeadings,
    ship_paragraphs: shipParagraphs,
    listing_controls: listingControls,
    cart_rows: cartRows,
  };
};
