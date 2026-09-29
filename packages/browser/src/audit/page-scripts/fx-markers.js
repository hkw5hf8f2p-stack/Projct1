// ЛИШЕ для харнесу перевірки (compare): збирає rect елементів з data-fx-мітками. Детектори цього файлу не використовують.
(() => {
  const out = {};
  for (const el of Array.from(document.querySelectorAll("[data-fx]"))) {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1) continue;
    const k = el.getAttribute("data-fx");
    (out[k] = out[k] || []).push({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
})()
