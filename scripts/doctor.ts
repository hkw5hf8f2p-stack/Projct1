/**
 * scripts/doctor — перевірка середовища (S1a крок 1, planning/engineering/toolchain-probe.md).
 * Пише JSON-артефакт; код виходу 1, якщо будь-яка обов'язкова перевірка FAIL.
 * Використання: pnpm doctor [--out <файл>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Status = "PASS" | "FAIL" | "INFO";
interface Check {
  id: string;
  status: Status;
  required: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const checks: Check[] = [];
const add = (c: Check) => {
  checks.push(c);
  console.log(`${c.status.padEnd(4)} ${c.id}: ${c.detail}`);
};
const sh = (cmd: string, args: string[], timeout = 15000): string | null => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const outIdx = process.argv.indexOf("--out");
const outFile = path.resolve(
  outIdx > 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1]! : path.join(ROOT, "planning/qa/artifacts/sprint-1a/doctor.json"),
);

async function main() {
  const rootPkg = readJson(path.join(ROOT, "package.json"));

  // 1. Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({ id: "node", status: nodeMajor >= 22 ? "PASS" : "FAIL", required: true, detail: `Node ${process.versions.node} (потрібно major >= 22)` });

  // 2. pnpm = packageManager
  const want = String(rootPkg.packageManager ?? "").replace(/^pnpm@/, "");
  const have = sh("pnpm", ["--version"]);
  add({
    id: "pnpm",
    status: have && have === want ? "PASS" : "FAIL",
    required: true,
    detail: `pnpm ${have ?? "відсутній"}, packageManager=pnpm@${want}`,
  });

  // 3. arch, uid
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  add({
    id: "platform",
    status: "INFO",
    required: false,
    detail: `${os.platform()} ${os.arch()}, uid=${process.getuid?.()}${isRoot ? " (root)" : ""}, rosetta=${os.platform() === "darwin" ? sh("sysctl", ["-n", "sysctl.proc_translated"]) : "n/a"}`,
    data: { platform: os.platform(), arch: os.arch(), uid: process.getuid?.() ?? null, release: os.release() },
  });

  // 4. Playwright / потрібна ревізія Chromium / встановлено?
  const pwCorePkg = path.dirname(require.resolve("playwright-core/package.json"));
  const pwVersion = readJson(path.join(pwCorePkg, "package.json")).version as string;
  const browsers = (readJson(path.join(pwCorePkg, "browsers.json")).browsers as Array<{ name: string; revision: string; browserVersion: string }>);
  const chromiumEntry = browsers.find((b) => b.name === "chromium")!;
  const shellEntry = browsers.find((b) => b.name === "chromium-headless-shell")!;
  const bp = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache/ms-playwright");
  const listing = existsSync(bp) ? readdirSync(bp) : [];
  const haveDir = (prefix: string, rev: string) =>
    existsSync(path.join(bp, `${prefix}-${rev}`, "INSTALLATION_COMPLETE"));
  const chromiumOk = haveDir("chromium", chromiumEntry.revision);
  const shellOk = haveDir("chromium_headless_shell", shellEntry.revision);
  add({
    id: "chromium_installed",
    status: chromiumOk && shellOk ? "PASS" : "FAIL",
    required: true,
    detail: `playwright-core ${pwVersion} потребує chromium r${chromiumEntry.revision} (${chromiumEntry.browserVersion}) + headless-shell r${shellEntry.revision}; PLAYWRIGHT_BROWSERS_PATH=${bp}; chromium=${chromiumOk}, headless_shell=${shellOk}; вміст: [${listing.join(", ")}]`,
    data: { playwright: pwVersion, required_revision: chromiumEntry.revision, browsers_path: bp, listing },
  });

  // 5. Chromium стартує з пісочницею (без --no-sandbox)
  let sandboxData: Record<string, unknown> = {};
  if (chromiumOk || shellOk) {
    const { chromium } = await import("playwright");
    try {
      const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      const page = await browser.newPage();
      await page.goto("about:blank");
      const ua = await page.evaluate(() => navigator.userAgent);
      const pid = (browser as unknown as { process?: () => { pid?: number } }).process?.()?.pid;
      let cmdline = "";
      try {
        if (pid) cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {
        /* не Linux */
      }
      const noSandboxFlag = cmdline.includes("--no-sandbox");
      await browser.close();
      sandboxData = { userAgent: ua, browser_version: browser.version(), no_sandbox_flag_in_cmdline: noSandboxFlag, cmdline_checked: cmdline !== "" };
      add({
        id: "chromium_sandbox",
        status: noSandboxFlag ? "FAIL" : "PASS",
        required: true,
        detail: `Chromium ${browser.version()} стартував із chromiumSandbox:true; --no-sandbox у cmdline: ${noSandboxFlag}; uid=${process.getuid?.()}`,
        data: sandboxData,
      });
    } catch (e) {
      const msg = String((e as Error).message).split("\n").slice(0, 3).join(" | ");
      add({ id: "chromium_sandbox", status: "FAIL", required: true, detail: `запуск із пісочницею не вдався (uid=${process.getuid?.()}${isRoot ? ", root: пісочниця не стартує під root — запускай через scripts/run-as-sitelens.sh" : ""}): ${msg}` });
    }
  } else {
    add({ id: "chromium_sandbox", status: "FAIL", required: true, detail: "пропущено: Chromium не встановлено" });
  }

  // 6. axe, lighthouse (версії + імпорт)
  const pkgOf = (name: string, from: string = ROOT) => {
    let dir = path.dirname(createRequire(path.join(from, "x.js")).resolve(name));
    while (!existsSync(path.join(dir, "package.json")) || readJson(path.join(dir, "package.json")).name !== name) dir = path.dirname(dir);
    return { dir, ...readJson(path.join(dir, "package.json")) } as { dir: string; version: string };
  };
  const axePw = pkgOf("@axe-core/playwright");
  const axeVersion = axePw.version;
  const axeCoreVersion = pkgOf("axe-core", axePw.dir).version;
  add({ id: "axe", status: "PASS", required: true, detail: `@axe-core/playwright ${axeVersion}, axe-core ${axeCoreVersion}` });
  try {
    const lhPkg = readJson(path.join(ROOT, "node_modules/lighthouse/package.json"));
    await import("lighthouse");
    add({ id: "lighthouse", status: "PASS", required: true, detail: `lighthouse ${lhPkg.version} імпортується (engines node ${lhPkg.engines?.node})` });
  } catch (e) {
    add({ id: "lighthouse", status: "FAIL", required: true, detail: `імпорт lighthouse: ${(e as Error).message}` });
  }

  // 7. БД — лише інформативно (S1a: БД out-of-scope)
  const pgBins = existsSync("/usr/lib/postgresql") ? readdirSync("/usr/lib/postgresql") : [];
  const embeddedPkg = `@embedded-postgres/${os.platform()}-${os.arch()}`;
  const embeddedLatest = sh("npm", ["view", embeddedPkg, "version"], 20000);
  add({
    id: "postgres_options",
    status: "INFO",
    required: false,
    detail: `system PG версії: [${pgBins.join(", ") || "немає"}] (${sh("pg_lsclusters", []) ?? "pg_lsclusters недоступний"}); ${embeddedPkg}@${embeddedLatest ?? "недоступний на npm"}. S1a не стартує БД.`,
    data: { system_pg_versions: pgBins, embedded_pkg: embeddedPkg, embedded_pkg_npm_version: embeddedLatest },
  });

  // 8. Мережа: registry vs публічний сайт (визначає, чи можливі живі пас-и)
  const probe = (url: string) => {
    const r = spawnSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", url], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : `ERR(${(r.stderr || "").trim().slice(0, 80)})`;
  };
  const npmCode = probe("https://registry.npmjs.org/");
  const siteCode = probe("https://example.com/");
  const live = /^2\d\d$/.test(siteCode);
  add({
    id: "internet",
    status: "INFO",
    required: false,
    detail: `registry.npmjs.org=${npmCode}, example.com=${siteCode} → живі публічні сайти ${live ? "доступні" : "НЕдоступні (живі пас-и ⏭️)"}`,
    data: { registry: npmCode, public_site: siteCode, live_sites_reachable: live },
  });

  // 9. Docker
  const dockerClient = sh("docker", ["--version"]);
  const dockerDaemon = dockerClient ? sh("docker", ["info", "--format", "{{.ServerVersion}}"], 8000) : null;
  add({ id: "docker", status: "INFO", required: false, detail: `клієнт: ${dockerClient ?? "немає"}; демон: ${dockerDaemon ?? "недоступний"}` });

  const failed = checks.filter((c) => c.required && c.status === "FAIL").map((c) => c.id);
  const report = {
    generated_at: new Date().toISOString(),
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    failed_required: failed,
    env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, node: process.versions.node, uid: process.getuid?.() ?? null },
    checks,
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nDOCTOR ${report.verdict}${failed.length ? ` (FAIL: ${failed.join(", ")})` : ""} → ${path.relative(ROOT, outFile)}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("doctor crashed", e);
  process.exit(2);
});
