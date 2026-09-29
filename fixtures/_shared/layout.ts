/** Спільний каркас сторінок фікстур: системні шрифти, фіксовані висоти, cookie-банер без мережевого запиту. */

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type BannerMode = "normal" | "stuck" | "off";

export interface LayoutOptions {
  title: string;
  description: string;
  brand: string;
  main: string;
  /** сторінка `main` має клас wide (без бічних відступів) */
  wide?: boolean;
  navLinks: Array<[href: string, label: string]>;
  footerLinks: Array<[href: string, label: string]>;
  /** aria-label іконкової кнопки меню; null = кнопка БЕЗ підпису (дефект №6) */
  menuLabel: string | null;
  /** cookie-банер: normal — кнопки працюють; stuck — інертні (контроль DEV-19); off — без банера */
  banner: BannerMode;
  /** контроль DEV-17: один same-origin POST на завантаженні (шар блоку його зупинить) */
  postOnLoad?: boolean;
  /** true, якщо в запиті вже є cookie згоди — банер не показується */
  consentGiven: boolean;
  /** маркер дефекту на кнопці меню (лише для перевірки) */
  menuMarker?: string;
  /** маркер на футері (місце, де мало б бути посилання на доставку; дефект №2) */
  footerMarker?: string;
}

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1a202c;background:#fff}
a{color:#1a56a0}
header.top{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid #cbd5e0;background:#f7fafc}
.brand{font-weight:700;font-size:20px;color:#1a202c;text-decoration:none}
nav.main ul{display:flex;gap:20px;list-style:none;margin:0;padding:0}
.menu-btn{display:none;width:44px;height:44px;border:1px solid #4a5568;background:#fff;border-radius:6px;align-items:center;justify-content:center;padding:0}
main{max-width:1100px;margin:0 auto;padding:24px}
main.wide{max-width:none;padding:0}
main.wide .pad{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:32px;line-height:1.2;margin:0 0 12px}
h2{font-size:20px;margin:0 0 6px}
.hero{display:block;width:100%;height:480px;object-fit:cover}
.cards{list-style:none;margin:16px 0;padding:0;display:grid;gap:16px}
.card{display:flex;gap:16px;align-items:flex-start;border:1px solid #cbd5e0;border-radius:8px;padding:12px;min-height:120px}
.card img{flex:none}
.btn,button.buy-btn{display:inline-block;background:#1a56a0;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;text-decoration:none;cursor:pointer}
.gallery{display:block;width:100%;max-width:390px;height:240px;object-fit:contain;background:#edf2f7}

.price{font-size:26px;font-weight:700;margin:0 0 8px}
.scroll{overflow-x:auto}
table.specs{border-collapse:collapse;width:540px}
table.specs th,table.specs td{border:1px solid #a0aec0;padding:6px 10px;text-align:left}
footer.foot{border-top:1px solid #cbd5e0;padding:16px 24px;background:#f7fafc}
footer.foot ul{display:flex;gap:20px;list-style:none;margin:0;padding:0;flex-wrap:wrap}
.cookie{position:fixed;left:0;right:0;bottom:0;background:#1a202c;color:#fff;padding:12px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:10}
.cookie p{margin:0;flex:1 1 240px}
.cookie button{font:inherit;border:1px solid #fff;background:#1a202c;color:#fff;border-radius:6px;padding:8px 14px;cursor:pointer;min-height:40px}
.cookie button.accept{background:#fff;color:#1a202c}
@media (max-width:768px){
  header.top{padding:0 12px}
  nav.main{display:none}
  .menu-btn{display:inline-flex}
  h1{font-size:26px}
  .hero{height:480px}
  main{padding:16px 12px}
  main.wide{padding:0}
  main.wide .pad{padding:16px 12px}
  footer.foot{padding:16px 12px}
  .cookie{padding:10px 12px}
}
`;

const COOKIE_SCRIPT = `document.querySelectorAll('#cookie-banner [data-cookie]').forEach(function(b){b.addEventListener('click',function(){document.cookie='sl_consent='+b.getAttribute('data-cookie')+'; path=/; max-age=31536000; SameSite=Lax';var e=document.getElementById('cookie-banner');if(e)e.remove();});});`;

export function layout(o: LayoutOptions): string {
  const nav = o.navLinks.map(([h, l]) => `<li><a href="${esc(h)}">${esc(l)}</a></li>`).join("");
  const foot = o.footerLinks.map(([h, l]) => `<li><a href="${esc(h)}">${esc(l)}</a></li>`).join("");
  const menuAttr = o.menuLabel === null ? "" : ` aria-label="${esc(o.menuLabel)}"`;
  const menuMarker = o.menuMarker ? ` data-fx="${o.menuMarker}"` : "";
  const banner =
    o.banner === "off" || o.consentGiven
      ? ""
      : `<aside id="cookie-banner" class="cookie" aria-label="Повідомлення про cookie"><p>Ми використовуємо cookie, щоб сайт працював. Ви можете залишити лише необхідні.</p><button type="button" data-cookie="necessary">Лише необхідні</button><button type="button" data-cookie="close" aria-label="Закрити">×</button><button type="button" class="accept" data-cookie="accept">Прийняти все</button></aside><script>${o.banner === "stuck" ? "/* контроль: кнопки інертні */" : COOKIE_SCRIPT}</script>`;
  const track = o.postOnLoad ? `<script>fetch('/track',{method:'POST',body:'x'}).catch(function(){});</script>` : "";
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="icon" href="data:,">
<style>${CSS}</style>
</head>
<body>
<header class="top">
<a class="brand" href="/">${esc(o.brand)}</a>
<nav class="main" aria-label="Головне меню"><ul>${nav}</ul></nav>
<button type="button" class="menu-btn"${menuAttr}${menuMarker}><svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false"><path d="M3 6h16M3 11h16M3 16h16" stroke="#1a202c" stroke-width="2" fill="none"/></svg></button>
</header>
<main${o.wide ? ' class="wide"' : ""}>
${o.main}
</main>
<footer class="foot"${o.footerMarker ? ` data-fx="${o.footerMarker}"` : ""}><ul>${foot}</ul></footer>
${banner}
${track}
</body>
</html>
`;
}

export function svgPlaceholder(label: string, fill: string, w = 240, h = 240): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${Math.round(h / 8)}" fill="#1a202c">${esc(label)}</text></svg>`;
}

export const LOREM = [
  "Модель створено для щоденного використання вдома й у поїздках. Корпус зібрано з матеріалів, які легко чистити, а всі вузли замінюються без інструментів.",
  "Кожен виріб проходить перевірку на заводі, а в комплекті ви знайдете докладну інструкцію українською. Гарантійний талон входить у коробку.",
  "Ми свідомо не обіцяємо неможливого: пристрій робить одну справу й робить її добре. Якщо потрібні додаткові функції, оберіть іншу модель у каталозі.",
  "Догляд за виробом простий: достатньо періодично промивати знімні частини теплою водою й витирати корпус м'якою тканиною.",
  "Комплектацію можна змінити перед оформленням: доступні кілька кольорів корпусу й набори змінних елементів.",
];
