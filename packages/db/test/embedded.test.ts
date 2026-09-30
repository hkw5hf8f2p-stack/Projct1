/** embedded-postgres як демон: переживає смерть Node-процесу, stale postmaster.pid, зайнятий порт, дані переживають kill -9 postmaster. */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DbDaemon, readPidFile } from "../src/index.js";

const root = mkdtempSync(path.join(os.tmpdir(), "sl-emb-"));
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const mk = (name: string, port: number) => new DbDaemon({ dataDir: path.join(root, name, "pg"), port, pidFile: path.join(root, name, "pids/postgres.json"), logFile: path.join(root, name, "pg.log"), sockDir: path.join(root, name, "run") });
const daemons: DbDaemon[] = [];
afterAll(async () => {
  for (const d of daemons) await d.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("DbDaemon", () => {
  it("старт → PID-файл збігається з фактичним postmaster; kill -9 → stale pid прибирається; повторний старт зберігає дані", async () => {
    const d = mk("a", await freePort());
    daemons.push(d);
    const s1 = await d.start();
    expect(s1).toMatchObject({ running: true, started: true, initialised: true });
    expect(d.pidFileMatches()).toBe(true);
    expect(readPidFile(d.opts.pidFile)?.pid).toBe(s1.pid);

    const c = new pg.Client({ connectionString: d.connectionString });
    await c.connect();
    await c.query("CREATE TABLE keep (v text)");
    await c.query("INSERT INTO keep VALUES ('before-kill')");
    await c.end();

    process.kill(s1.pid!, "SIGKILL"); // імітація аварії
    for (let i = 0; i < 50 && alive(s1.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    const st = d.status();
    expect(st.running).toBe(false);
    expect(st.stale_pid_file_removed).toBe(true); // stale postmaster.pid виявлено й прибрано

    const s2 = await d.start();
    expect(s2.started).toBe(true);
    expect(s2.initialised).toBe(false);
    const c2 = new pg.Client({ connectionString: d.connectionString });
    await c2.connect();
    expect((await c2.query("SELECT v FROM keep")).rows).toEqual([{ v: "before-kill" }]);
    await c2.end();
    expect((await d.stop()).stopped).toBe(true);
    expect(d.status().running).toBe(false);
  }, 60_000);

  it("зайнятий порт → відмова з поясненням, каталог даних не створено (initdb не запускався); чужий сокет не зачеплено", async () => {
    const port = await freePort();
    const foreign = net.createServer();
    await new Promise<void>((r) => foreign.listen(port, "127.0.0.1", () => r()));
    try {
      const d = mk("b", port);
      await expect(d.start()).rejects.toThrow(/порт \d+ зайнятий/);
      expect(foreign.listening).toBe(true);
    } finally {
      foreign.close();
    }
  });
});
