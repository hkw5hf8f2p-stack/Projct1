// Узагальнений парсер цін (page-type-spec §2). Виконується і в сторінці (extract.js), і в Node (price-parser.ts): plain JS без імпортів.
// Вираз-IIFE повертає (text) => [{value, currency, text, index, prefix_from}]. Число: групування пробілом/NBSP/тонким/апострофом/./, +
// десяткова частина 1–2 цифри; валюта поруч (≤ 1 пробіл/NBSP) до або після; префікс від|from|od|ab. Без валюти — не ціна
// (телефон, дата, рік, %, кількість відсіюються самим правилом «потрібна валюта»).
(() => {
  const CUR = "(?:₴|грн\\.?|uah|€|eur|\\$|usd|£|gbp|zł|pln)";
  const NUM = "(?:\\d{1,3}(?:[ \\u00a0\\u202f\\u2009.,']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
  const FROM = "(?:від|from|od|ab)";
  const src = "(?<![\\p{L}\\d.,])(?:(" + FROM + ")\\s+)?(?:(" + CUR + ")\\s?(" + NUM + ")|(" + NUM + ")\\s?(" + CUR + "))(?![\\p{L}\\d])";
  const parseNum = (s) => {
    const d = s.replace(/[    ']/g, "");
    const seps = d.match(/[.,]/g) || [];
    if (seps.length === 0) return Number(d);
    const last = Math.max(d.lastIndexOf("."), d.lastIndexOf(","));
    const after = d.length - last - 1;
    const distinct = new Set(seps).size > 1;
    if (distinct || (seps.length === 1 && after <= 2)) return Number(d.slice(0, last).replace(/[.,]/g, "") + "." + d.slice(last + 1));
    return Number(d.replace(/[.,]/g, ""));
  };
  const code = (c) => {
    const x = c.toLowerCase().replace(/\.$/, "");
    if (x === "₴" || x === "грн" || x === "uah") return "UAH";
    if (x === "€" || x === "eur") return "EUR";
    if (x === "$" || x === "usd") return "USD";
    if (x === "£" || x === "gbp") return "GBP";
    return "PLN";
  };
  return (text) => {
    const re = new RegExp(src, "giu");
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const cur = m[2] || m[5];
      const num = m[3] || m[4];
      out.push({ value: parseNum(num), currency: code(cur), text: m[0], index: m.index, prefix_from: !!m[1] });
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  };
})()
