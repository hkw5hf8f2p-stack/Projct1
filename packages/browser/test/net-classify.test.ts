import { describe, expect, it } from "vitest";
import { classifyIpLiteral, classifyResolved, parseIPv4Loose, parseIPv6 } from "../src/net/ip-classify.js";
import { isDeniedActionText, isDeniedActionUrl, normalizeTargetUrl } from "../src/net/url-guard.js";

/** Кожен діапазон §49 + B1 + IANA special-purpose: [адреса, очікуваний CIDR]. */
const BLOCKED: Array<[string, string]> = [
  // §49
  ["127.0.0.1", "127.0.0.0/8"], ["127.255.255.254", "127.0.0.0/8"], ["127.0.0.2", "127.0.0.0/8"],
  ["10.0.0.1", "10.0.0.0/8"], ["10.255.255.255", "10.0.0.0/8"],
  ["172.16.0.1", "172.16.0.0/12"], ["172.31.255.255", "172.16.0.0/12"],
  ["192.168.0.1", "192.168.0.0/16"], ["192.168.255.255", "192.168.0.0/16"],
  ["169.254.169.254", "169.254.0.0/16"], ["169.254.0.1", "169.254.0.0/16"],
  ["::1", "::1/128"], ["fc00::1", "fc00::/7"], ["fd00:ec2::254", "fc00::/7"], ["fdff:ffff::1", "fc00::/7"],
  ["fe80::1", "fe80::/10"], ["febf::1", "fe80::/10"],
  // B1
  ["0.0.0.0", "0.0.0.0/8"], ["0.1.2.3", "0.0.0.0/8"],
  ["100.64.0.1", "100.64.0.0/10"], ["100.127.255.255", "100.64.0.0/10"], ["100.100.100.200", "100.64.0.0/10"],
  ["224.0.0.1", "224.0.0.0/4"], ["239.255.255.250", "224.0.0.0/4"], ["ff02::1", "ff00::/8"], ["ff05::2", "ff00::/8"],
  ["::ffff:127.0.0.1", "::ffff:0:0/96"], ["::ffff:7f00:1", "::ffff:0:0/96"], ["::ffff:169.254.169.254", "::ffff:0:0/96"],
  ["::ffff:8.8.8.8", "::ffff:0:0/96"], ["[::ffff:10.0.0.1]", "::ffff:0:0/96"],
  ["64:ff9b::7f00:1", "64:ff9b::/96"], ["64:ff9b::a9fe:a9fe", "64:ff9b::/96"], ["64:ff9b::8.8.8.8", "64:ff9b::/96"],
  // IANA special-purpose, решта
  ["192.0.0.192", "192.0.0.0/24"], ["192.0.2.1", "192.0.2.0/24"], ["198.51.100.7", "198.51.100.0/24"],
  ["203.0.113.9", "203.0.113.0/24"], ["198.18.0.1", "198.18.0.0/15"], ["198.19.255.255", "198.18.0.0/15"],
  ["192.88.99.1", "192.88.99.0/24"], ["240.0.0.1", "240.0.0.0/4"], ["255.255.255.255", "255.255.255.255/32"],
  ["168.63.129.16", "168.63.129.16/32"],
  ["::", "::/128"], ["::7f00:1", "::/96"], ["::127.0.0.1", "::/96"], ["::ffff:0:7f00:1", "::ffff:0:0:0/96"],
  ["64:ff9b:1::1", "64:ff9b:1::/48"], ["100::1", "100::/64"],
  ["2002:7f00:1::1", "2002::/16"], ["2002:c0a8:101::", "2002::/16"], // 6to4 з 127.0.0.1 / 192.168.1.1
  ["2001:0:4136:e378:8000:63bf:80ff:fffe", "2001::/32"], // Teredo, клієнт 127.0.0.1 (інвертовано)
  ["2001:db8::1", "2001:db8::/32"], ["2001:10::1", "2001:10::/28"], ["2001:20::1", "2001:20::/28"],
  ["3fff::1", "3fff::/20"], ["5f00::1", "5f00::/16"], ["fec0::1", "fec0::/10"],
  ["4000::1", "!2000::/3"], ["::2", "::/96"], ["1::", "!2000::/3"],
];

/** Нечислові записи IPv4 (десяткові, вісімкові, hex, скорочені, змішані) → канонічна IPv4. */
const ENCODINGS: Array<[string, string]> = [
  ["2130706433", "127.0.0.1"], ["017700000001", "127.0.0.1"], ["0x7f000001", "127.0.0.1"], ["0x7F.1", "127.0.0.1"],
  ["0177.0.0.1", "127.0.0.1"], ["0x7f.0.0.1", "127.0.0.1"], ["127.1", "127.0.0.1"], ["127.0.1", "127.0.0.1"],
  ["0", "0.0.0.0"], ["0x0", "0.0.0.0"], ["2852039166", "169.254.169.254"], ["0xa9fea9fe", "169.254.169.254"],
  ["0251.0376.0251.0376", "169.254.169.254"], ["169.254.43518", "169.254.169.254"], ["10.1", "10.0.0.1"],
  ["167772161", "10.0.0.1"], ["0xc0.0xa8.1.1", "192.168.1.1"], ["3232235777", "192.168.1.1"], ["127.0.0.1.", "127.0.0.1"],
];

const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
  "192.167.255.255", "192.169.0.0", "169.253.255.255", "223.255.255.255", "11.0.0.1", "2606:4700:4700::1111",
  "2a00:1450:4001:80b::200e", "2001:4860:4860::8888"];

describe("SSRF-класифікатор IP (§49 + B1)", () => {
  it.each(BLOCKED)("блок %s → %s", (ip, cidr) => {
    const v = classifyIpLiteral(ip);
    expect(v, ip).not.toBeNull();
    expect(v!.allowed).toBe(false);
    expect(v!.range).toBe(cidr);
  });

  it.each(ALLOWED)("дозвіл публічної %s (перевірка вміє сказати «так» — межі діапазонів)", (ip) => {
    const v = classifyIpLiteral(ip);
    expect(v!.allowed).toBe(true);
  });

  it.each(ENCODINGS)("запис %s = %s і заблоковано", (enc, canon) => {
    const n = parseIPv4Loose(enc);
    expect(n).not.toBeNull();
    const v = classifyIpLiteral(enc)!;
    expect(v.ip).toBe(canon);
    expect(v.allowed).toBe(false);
  });

  it("некоректні числові записи не проходять як ім'я хоста", () => {
    for (const bad of ["256.0.0.1", "1.2.3.4.5", "0x1g.0.0.1", "4294967296", "08.0.0.1"]) {
      const v = classifyIpLiteral(bad);
      expect(v, bad).not.toBeNull();
      expect(v!.allowed, bad).toBe(false);
    }
    expect(classifyIpLiteral("example.com")).toBeNull();
  });

  it("вбудована IPv4 названа в причині (mapped / NAT64 / 6to4 / Teredo)", () => {
    expect(classifyIpLiteral("::ffff:127.0.0.1")!.reason).toContain("127.0.0.1");
    expect(classifyIpLiteral("64:ff9b::a9fe:a9fe")!.reason).toContain("169.254.169.254");
    expect(classifyIpLiteral("2002:c0a8:101::")!.reason).toContain("192.168.1.1");
    expect(classifyIpLiteral("2001:0:4136:e378:8000:63bf:80ff:fffe")!.reason).toContain("127.0.0.1");
  });

  it("IPv6-парсер: zone id, дужки, некоректні форми", () => {
    expect(parseIPv6("fe80::1%eth0")).toBe(parseIPv6("fe80::1"));
    expect(parseIPv6("[::1]")).toBe(1n);
    for (const bad of ["1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", ":::"]) expect(parseIPv6(bad), bad).toBeNull();
    expect(classifyResolved("::1", 6).allowed).toBe(false);
    expect(classifyResolved("8.8.8.8", 4).allowed).toBe(true);
  });

  it("КОНТРОЛЬ «вміє впасти»: наївний класифікатор лише за рядковими префіксами §49 пропускає більшість векторів B1", () => {
    // Те, що є в SPEC §49 дослівно, як префікс рядка — типова наївна реалізація.
    const naive = (s: string) => /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|f[cd]|fe[89ab])/i.test(s);
    const vectors = [...BLOCKED.map(([ip]) => ip), ...ENCODINGS.map(([e]) => e)];
    const missedByNaive = vectors.filter((v) => !naive(v));
    const missedByReal = vectors.filter((v) => classifyIpLiteral(v)?.allowed !== false);
    expect(missedByNaive.length).toBe(59); // наївний FAIL: пропускає 0.0.0.0, 100.64/10, mapped, NAT64, 2130706433, …
    expect(missedByReal).toEqual([]); // справжній PASS
  });
});

describe("нормалізація URL цілі", () => {
  const ok = (u: string) => normalizeTargetUrl(u);
  it("схеми поза http/https відкидаються", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/", "gopher://x.com/", "javascript:alert(1)", "data:text/html,x", "ws://example.com/", "chrome://version"]) {
      expect(ok(u).ok, u).toBe(false);
    }
  });
  it("числові записи хоста в URL → канонічна IPv4 → блок", () => {
    for (const u of ["http://2130706433/", "http://0177.0.0.1/", "http://0x7f.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/latest/meta-data", "http://169.254.169.254/", "http://0/", "http://[::]/"]) {
      const r = ok(u);
      expect(r.ok, u).toBe(false);
    }
  });
  it("userinfo відкидається (плутанина public@private)", () => {
    expect(ok("http://example.com@127.0.0.1/").ok).toBe(false);
    expect(ok("http://user:pass@example.com/").ok).toBe(false);
    expect(ok("http://example.com%40127.0.0.1/").ok).toBe(false); // % у хості — невалідний URL
  });
  it("metadata-імена та локальні зони блокуються до резолву", () => {
    for (const u of ["http://metadata.google.internal/computeMetadata/v1/", "http://metadata.goog/", "http://localhost:8080/", "http://foo.localhost/", "http://printer.local/", "http://intranet/", "http://LOCALHOST./"]) {
      expect(ok(u).ok, u).toBe(false);
    }
  });
  it("IDN → punycode, порт і дефолтні порти", () => {
    const r = ok("https://приклад.укр:8443/шлях?q=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe("xn--80aikifvh.xn--j1amh");
      expect(r.port).toBe(8443);
      expect(r.hostKind).toBe("domain");
    }
    const h = ok("http://Example.COM");
    expect(h.ok && h.port).toBe(80);
    expect(h.ok && h.host).toBe("example.com");
    const s = ok("https://8.8.8.8/");
    expect(s.ok && s.port).toBe(443);
    expect(s.ok && s.hostKind).toBe("ipv4");
    const v6 = ok("http://[2606:4700:4700::1111]:81/");
    expect(v6.ok && v6.hostKind).toBe("ipv6");
  });
  it("IDN-гомогліф точки/цифри: повноширинні цифри нормалізуються в IPv4 і блокуються", () => {
    expect(ok("http://１２７.０.０.１/").ok).toBe(false);
  });
});

describe("deny-list URL дій (G0-11)", () => {
  const denied = [
    "https://shop.test/?add-to-cart=42", "https://shop.test/product/x?add_to_cart=1", "https://shop.test/cart/add?id=1",
    "https://shop.test/checkout", "https://shop.test/checkout/step-2", "https://shop.test/logout", "https://shop.test/account/sign-out",
    "https://shop.test/item?action=delete", "https://shop.test/?action=anything", "https://shop.test/items/5/delete",
    "https://shop.test/newsletter/unsubscribe?u=1", "https://shop.test/wp-admin/", "https://shop.test/wp-login.php",
    "https://shop.test/ADD-TO-CART/9", "https://shop.test/%63heckout",
  ];
  const allowed = ["https://shop.test/", "https://shop.test/product/42", "https://shop.test/cart", "https://shop.test/shipping",
    "https://shop.test/about", "https://shop.test/category?page=2", "https://shop.test/blog/checkout-tips-guide"];
  it.each(denied)("deny %s", (u) => expect(isDeniedActionUrl(u).denied).toBe(true));
  it.each(allowed)("allow %s", (u) => expect(isDeniedActionUrl(u).denied).toBe(false));
  it("текст елемента", () => {
    for (const t of ["Add to cart", "Купити", "Додати  в кошик", "Оформити замовлення", "Вийти", "Log out", "Unsubscribe"]) expect(isDeniedActionText(t).denied, t).toBe(true);
    for (const t of ["Доставка", "Про нас", "Shipping info", "Каталог"]) expect(isDeniedActionText(t).denied, t).toBe(false);
  });
});
