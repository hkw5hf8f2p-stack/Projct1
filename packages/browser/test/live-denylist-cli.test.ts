/**
 * S1b-live: `audit:live -- https://kredens.com.ua` відмовляє ДО будь-якого мережевого запиту.
 * Доказ — strace -f -e trace=network усього процесу CLI: жодного connect/sendto/sendmsg на не-loopback/не-unix адреси
 * (DNS-запит теж був би connect/sendto на резолвер) . Контроль: дозволений хост без списку
 * доходить до мережі (strace бачить connect) — тобто перевірка вміє впасти. Контроль не відкриває нічого зовнішнього:
 * використовуємо loopback-URL, який CLI відхиляє на кроці url, тож для «контролю, що strace ловить connect» береться `curl` до 127.0.0.1.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const haveStrace = existsSync("/usr/bin/strace");

function strace(args: string[], env: Record<string, string>): { status: number | null; out: string; trace: string } {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "sl-st-")), "trace.txt");
  const r = spawnSync("strace", ["-f", "-s", "200", "-e", "trace=network", "-o", f, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: String(r.stdout) + String(r.stderr), trace: existsSync(f) ? readFileSync(f, "utf8") : "" };
}
const external = (trace: string) =>
  trace.split("\n").filter((l) => /(connect|sendto|sendmsg)\(/.test(l) && !/AF_UNIX|sin_addr=inet_addr\("127\.|sin6_addr=inet_pton\(AF_INET6, "::1"|AF_NETLINK/.test(l));

describe.skipIf(!haveStrace)("audit:live і SITE_DENYLIST (kredens): відмова до мережі", () => {
  for (const u of ["https://kredens.com.ua", "https://shop.kredens.com.ua/x"]) {
    it(`${u}: код 3, 0 зовнішніх мережевих викликів`, () => {
      const r = strace(["node_modules/.bin/tsx", "scripts/audit-live.ts", "--", u], { SITELENS_SITE_DENYLIST: "kredens.com.ua" });
      expect(r.status).toBe(3);
      expect(r.trace.length).toBeGreaterThan(0);
      expect(r.out).toContain("ВІДМОВА (denylist)");
      expect(external(r.trace)).toEqual([]);
    });
  }
  it("контроль: strace справді ловить зовнішній connect (curl до 192.0.2.1 — TEST-NET, пакет не піде далі таймауту 1 с)", () => {
    const r = strace(["curl", "-s", "-m", "1", "http://192.0.2.1/"], {});
    expect(external(r.trace).length).toBeGreaterThan(0);
  });
});
