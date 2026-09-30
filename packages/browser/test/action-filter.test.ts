/**
 * Кодовий фільтр дій агента (G0-11): чисті функції. Кожне правило показане на позитивному (заборонено) і негативному (дозволено) вході.
 */
import { describe, expect, it } from "vitest";
import { checkAction, checkElement, classifyElementText, denyUrl, parseTarget, sameOrigin, type ElementFacts } from "../src/agent/action-filter.js";

const O = "http://127.0.0.1:4210";
const el = (o: Partial<ElementFacts>): ElementFacts => ({ tag: "a", text: "Delivery", href: `${O}/help/shipping`, submits_form: false, has_download_attr: false, ...o });

describe("denyUrl: deny-list G0-11", () => {
  const denied: Array<[string, string]> = [
    [`${O}/?add-to-cart=7`, "add_to_cart"], [`${O}/catalog?add-to-cart=1`, "add_to_cart"], [`${O}/shop/?add_to_cart=5`, "add_to_cart"], [`${O}/add-to-cart/7`, "add_to_cart"],
    [`${O}/cart/add`, "cart_mutation"], [`${O}/cart/add/12`, "cart_mutation"], [`${O}/cart/remove?id=3`, "cart_mutation"], [`${O}/?remove_item=abc`, "add_to_cart"],
    [`${O}/checkout`, "checkout"], [`${O}/checkout/step-2`, "checkout"], [`${O}/checkout-view`, "checkout"], [`${O}/ua/checkout.html`, "checkout"],
    [`${O}/logout`, "logout"], [`${O}/account/logout/`, "logout"], [`${O}/sign-out`, "logout"], [`${O}/?logout=1`, "logout"], [`${O}/%6Cogout`, "logout"],
    [`${O}/product?action=delete`, "delete"], [`${O}/product/delete/5`, "delete"], [`${O}/catalog?action=delete&list=compare`, "delete"],
    [`${O}/unsubscribe`, "unsubscribe"], [`${O}/newsletter/unsubscribe?t=1`, "unsubscribe"],
    [`${O}/wp-admin/`, "admin"], [`${O}/wp-admin/post.php`, "admin"], [`${O}/wp-login.php`, "admin"],
    [`${O}/page?action=anything`, "action_param"], [`${O}/x?ACTION=Edit`, "action_param"],
    [`${O}/files/price.zip`, "binary_download"], [`${O}/a/setup.exe`, "binary_download"], [`${O}/catalog.pdf`, "binary_download"],
    ["mailto:sales@example.com", "bad_scheme"], ["javascript:void(0)", "bad_scheme"], ["data:text/html,x", "bad_scheme"], ["not a url", "bad_url"],
  ];
  it.each(denied)("%s → %s", (u, rule) => { expect(denyUrl(u, "navigation")).toBe(rule); });

  const allowed = [`${O}/`, `${O}/catalog`, `${O}/help/shipping`, `${O}/about?member=2`, `${O}/product/aquapro-x200`, `${O}/cart-view`, `${O}/search?q=checkout+bag`, `${O}/blog/deleted-items-policy-2024`, `${O}/#section`, `${O}/reaction/actions`];
  it.each(allowed)("дозволено: %s", (u) => { expect(denyUrl(u, "navigation")).toBeNull(); });

  it("request-режим (xhr/fetch): admin-ajax.php?action=search дозволено, але станозмінне значення action — ні", () => {
    expect(denyUrl(`${O}/wp-admin/admin-ajax.php?action=search`, "request")).toBeNull();
    expect(denyUrl(`${O}/wp-admin/admin-ajax.php?action=woocommerce_add_to_cart`, "request")).toBe("action_param");
    expect(denyUrl(`${O}/api?action=delete_item`, "request")).toBe("delete");
    // navigation-режим — будь-який ?action=
    expect(denyUrl(`${O}/wp-admin/admin-ajax.php?action=search`, "navigation")).toBe("action_param");
  });
});

describe("sameOrigin", () => {
  it("scheme+host+port", () => {
    expect(sameOrigin(`${O}/a`, `${O}/b`)).toBe(true);
    expect(sameOrigin("http://127.0.0.1:4211/", `${O}/`)).toBe(false);
    expect(sameOrigin("https://127.0.0.1:4210/", `${O}/`)).toBe(false);
    expect(sameOrigin("http://sub.127.0.0.1:4210/", `${O}/`)).toBe(false);
    expect(sameOrigin("garbage", `${O}/`)).toBe(false);
  });
});

describe("classifyElementText: комерційні CTA vs станозмінні дієслова", () => {
  it.each([["Add to cart", "commercial_cta"], ["В кошик", "commercial_cta"], ["Додати в кошик", "commercial_cta"], ["Buy now", "commercial_cta"], ["Купити", "commercial_cta"], ["Checkout", "commercial_cta"], ["Zamów teraz", "commercial_cta"],
    ["Sign out", "state_text"], ["Log out", "state_text"], ["Вийти", "state_text"], ["Delete", "state_text"], ["Видалити", "state_text"], ["Remove listing", "state_text"], ["Прибрати з порівняння", "state_text"],
    ["Subscribe", "state_text"], ["Підписатися", "state_text"], ["Place order", "state_text"], ["Надіслати", "state_text"], ["Send", "state_text"], ["Sign in", "state_text"],
    ["Delivery and payment", null], ["Каталог", null], ["Details", null], ["Про нас", null], ["Shipping & payment", null], ["Показати більше", null], ["Removed items are shown below", null] as [string, null]])("«%s» → %s", (t, r) => { expect(classifyElementText(t)).toBe(r); });
});

describe("parseTarget / checkAction: семантичні локатори, список дій §20", () => {
  it("приймає role:\"name\"", () => { expect(parseTarget('link:"Delivery and payment"')).toEqual({ role: "link", name: "Delivery and payment" }); });
  it.each(["x=120,y=340", "#buy", "//a[@href='/logout']", "http://127.0.0.1/logout", "button:Buy now", ".btn > a", "a[href='/x']", "link:\"\"", "menu:\"X\"", "click at 10, 20"])("відхиляє «%s»", (t) => { expect(parseTarget(t)).toBeNull(); });
  it("дії §20", () => {
    expect(checkAction({ action: "click", target: 'button:"Details"' }).ok).toBe(true);
    expect(checkAction({ action: "scroll", target: "down" }).ok).toBe(true);
    expect(checkAction({ action: "back", target: "" }).ok).toBe(true);
    expect(checkAction({ action: "stop_success", target: "" }).ok).toBe(true);
    for (const a of ["submit_payment", "send_message", "submit_contact_form", "create_account", "delete", "download_unknown_binary", "external_login"]) {
      expect(checkAction({ action: a, target: "" })).toMatchObject({ ok: false, rule: "forbidden_action" });
    }
    expect(checkAction({ action: "hover", target: "" })).toMatchObject({ ok: false, rule: "unknown_action" });
    expect(checkAction({ action: "click", target: "x=1,y=2" })).toMatchObject({ ok: false, rule: "bad_target" });
    expect(checkAction({ action: "scroll", target: "left" })).toMatchObject({ ok: false, rule: "bad_target" });
    expect(checkAction({ action: "back", target: 'link:"x"' })).toMatchObject({ ok: false, rule: "bad_target" });
  });
});

describe("checkElement: навігація лише same-origin, deny-list URL/тексту, submit, download", () => {
  it("легітимне внутрішнє посилання проходить", () => { expect(checkElement("navigate_internal_link", el({}), O)).toEqual({ ok: true }); });
  it("cross-origin href → cross_origin (і для click, і для navigate_internal_link)", () => {
    for (const a of ["click", "navigate_internal_link"] as const) expect(checkElement(a, el({ href: "http://evil.example/x" }), O)).toMatchObject({ ok: false, rule: "cross_origin" });
    expect(checkElement("click", el({ href: "http://127.0.0.1:4999/x" }), O)).toMatchObject({ ok: false, rule: "cross_origin" });
  });
  it("deny-list href (навіть з нейтральним текстом «Details») → правило URL", () => {
    expect(checkElement("click", el({ text: "Details", href: `${O}/?add-to-cart=7` }), O)).toMatchObject({ ok: false, rule: "add_to_cart" });
    expect(checkElement("click", el({ text: "Details", href: `${O}/logout` }), O)).toMatchObject({ ok: false, rule: "logout" });
    expect(checkElement("click", el({ text: "Details", href: `${O}/p?action=delete` }), O)).toMatchObject({ ok: false, rule: "delete" });
  });
  it("deny-list тексту при нейтральному href: «Sign out» → state_text; «Add to cart» → commercial_cta (знайдено, не натиснуто)", () => {
    expect(checkElement("click", el({ text: "Sign out", href: `${O}/x` }), O)).toMatchObject({ ok: false, rule: "state_text" });
    expect(checkElement("click", el({ tag: "button", text: "Add to cart", href: null }), O)).toMatchObject({ ok: false, rule: "commercial_cta" });
  });
  it("submit не-GET форми, download → відмова; navigate_internal_link без href → not_a_link", () => {
    expect(checkElement("click", el({ tag: "button", text: "Continue", href: null, submits_form: true }), O)).toMatchObject({ ok: false, rule: "form_submit" });
    expect(checkElement("click", el({ has_download_attr: true }), O)).toMatchObject({ ok: false, rule: "download_attr" });
    expect(checkElement("navigate_internal_link", el({ tag: "button", href: null }), O)).toMatchObject({ ok: false, rule: "not_a_link" });
  });
  it("кнопка без href (JS-акордеон «Details») дозволена", () => { expect(checkElement("click", el({ tag: "button", text: "Details", href: null }), O)).toEqual({ ok: true }); });
});
