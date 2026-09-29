/**
 * Cookie-банер (SPEC §14, DEV-5): Reject/Necessary → Close → Accept. Ніколи не підписка, не сповіщення, не геолокація.
 * Кожна дія логуються (факт існування банера + які кнопки натиснуто) — потрапляє в докази.
 * Клік — DOM-подія на цільовій сторінці; будь-який не-GET, що він спричинить, зупинить guard і збільшить лічильник.
 */
import type { Page } from "playwright";
import type { BannerAction, BannerRecord } from "./types.js";

const FIND = `(() => {
  const vis = (el) => { try { if (!el.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false; } catch (e) {} const r = el.getBoundingClientRect(); return r.width * r.height >= 1; };
  document.querySelectorAll('[data-sl-banner]').forEach((e) => e.removeAttribute('data-sl-banner'));
  const WORDS = /cookie|кукі|файли cookie|consent|gdpr|згод/i;
  const ID = /cookie|consent|gdpr|cmp/i;
  const cands = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!vis(el)) continue;
    const btns = el.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[role="button"]');
    if (btns.length === 0) continue;
    const cs = getComputedStyle(el);
    const idc = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    const dialog = el.matches('[role="dialog"],[role="alertdialog"],dialog[open]');
    const floating = cs.position === 'fixed' || cs.position === 'sticky';
    const t = (el.innerText || '').slice(0, 600);
    if ((ID.test(idc) && WORDS.test(t)) || ((dialog || floating) && WORDS.test(t))) cands.push(el);
  }
  // найменший контейнер із кнопками
  const best = cands.filter((c) => !cands.some((o) => o !== c && c.contains(o)))[0];
  if (!best) return false;
  best.setAttribute('data-sl-banner', '1');
  return true;
})()`;

const STILL_VISIBLE = `(() => { const e = document.querySelector('[data-sl-banner]'); if (!e || !e.isConnected) return false; try { if (!e.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false; } catch (err) {} const r = e.getBoundingClientRect(); return r.width * r.height >= 1; })()`;

const STEPS: Array<{ step: BannerAction["step"]; re: RegExp }> = [
  { step: "reject", re: /^(лише|тільки|тiльки)?\s*(необхідн|обов'язков)|відхилити|відмовитися|reject|decline|deny|necessary|essential|only necessary/i },
  { step: "close", re: /^(закрити|close|dismiss|×|✕|x)$/i },
  { step: "accept", re: /^(прийняти|погодитися|погоджуюсь|приймаю|accept|allow|agree|ok|got it|продовжити|continue)/i },
];

export async function handleBanner(page: Page): Promise<BannerRecord> {
  const detected = (await page.evaluate(FIND)) as boolean;
  if (!detected) return { detected: false, state: "none", actions: [] };
  const actions: BannerAction[] = [];
  const container = page.locator('[data-sl-banner="1"]');
  for (const { step, re } of STEPS) {
    if (!((await page.evaluate(STILL_VISIBLE)) as boolean)) break;
    const btns = container.locator('button, [role="button"], input[type="button"], input[type="submit"]');
    const count = await btns.count();
    let target = -1;
    let label = "";
    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      const name = ((await b.getAttribute("aria-label")) ?? (await b.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      const text = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (re.test(name) || re.test(text)) {
        target = i;
        label = name || text;
        break;
      }
    }
    if (target < 0) continue;
    let clicked = false;
    let method: BannerAction["method"] = "none";
    try {
      await btns.nth(target).click({ timeout: 1500 });
      clicked = true;
      method = "click";
    } catch {
      // напр. широка мобільна сторінка: fixed-банер поза візуальним вікном. Семантичний клік по елементу (як
      // element.click() з accessibility-дерева) — та сама подія сайту, без координат.
      try {
        await btns.nth(target).dispatchEvent("click", undefined, { timeout: 1500 });
        clicked = true;
        method = "dispatch";
      } catch {
        clicked = false;
      }
    }
    await page.waitForTimeout(80);
    const stillOpen = (await page.evaluate(STILL_VISIBLE)) as boolean;
    actions.push({ step, label, clicked, method, hidden_after: !stillOpen });
  }
  const open = (await page.evaluate(STILL_VISIBLE)) as boolean;
  return { detected: true, state: open ? "open" : "closed", actions };
}
