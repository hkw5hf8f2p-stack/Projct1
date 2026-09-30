/** PID-облік (G0-28): прибирання лише записаних процесів мертвого власника; чужі, живий власник і повторно використаний PID — не чіпаємо. */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOrphansFromFile, descendantsOf, isSameProc, newPidFile, procStart, readStat, survivors, writePidFile, type TrackedProc } from "../src/procs.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "sl-procs-"));
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) if (c.pid && isSameProc({ pid: c.pid, start: null })) try { process.kill(c.pid, "SIGKILL"); } catch { /* вже немає */ }
});
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** «браузер»: копія sleep з ім'ям headless_shell → comm збігається з реальним; живе окремо від тесту */
const decoyBin = path.join(dir, "headless_shell");
copyFileSync("/bin/sleep", decoyBin);
const start = (bin = decoyBin): ChildProcess => {
  const c = spawn(bin, ["300"], { stdio: "ignore", detached: true });
  c.unref();
  spawned.push(c);
  return c;
};
const track = (c: ChildProcess, role = "browser"): TrackedProc => ({ pid: c.pid!, start: procStart(c.pid!), comm: readStat(c.pid!)!.comm, role });
const deadOwner = async (): Promise<{ pid: number; start: string | null }> => {
  const c = spawn("/bin/true");
  const start = procStart(c.pid!);
  await new Promise((r) => c.on("exit", r));
  return { pid: c.pid!, start };
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("cleanupOrphansFromFile", () => {
  it("власник мертвий → записана дитина вбита; НЕзаписаний чужий процес з тим самим іменем живий", async () => {
    const mine = start();
    const foreign = start(); // те саме ім'я comm, але його немає в PID-файлі
    await new Promise((r) => setTimeout(r, 100));
    const owner = await deadOwner();
    const file = path.join(dir, "a.json");
    writePidFile(file, { owner: "worker", pid: owner.pid, start: owner.start, written_at: new Date().toISOString(), children: [track(mine)] });
    expect(alive(mine.pid!)).toBe(true);
    const rep = cleanupOrphansFromFile(file);
    await new Promise((r) => setTimeout(r, 200));
    expect(rep.owner_was_alive).toBe(false);
    expect(rep.killed.map((k) => k.pid)).toEqual([mine.pid]);
    expect(alive(mine.pid!)).toBe(false);
    expect(alive(foreign.pid!)).toBe(true); // контроль: чужий не зачеплено
  });

  it("власник ЖИВИЙ → нікого не чіпаємо (негативний контроль)", () => {
    const c = start();
    const file = path.join(dir, "b.json");
    writePidFile(file, { ...newPidFile("worker", process.pid, [track(c)]) });
    const rep = cleanupOrphansFromFile(file);
    expect(rep.owner_was_alive).toBe(true);
    expect(rep.killed).toEqual([]);
    expect(alive(c.pid!)).toBe(true);
  });

  it("повторно використаний PID (start не збігається) → не вбиваємо", async () => {
    const c = start();
    const t = track(c);
    const owner = await deadOwner();
    const file = path.join(dir, "c.json");
    writePidFile(file, { owner: "worker", pid: owner.pid, start: owner.start, written_at: "", children: [{ ...t, start: "1" }] });
    const rep = cleanupOrphansFromFile(file);
    expect(rep.killed).toEqual([]);
    expect(rep.skipped_reused_pid).toEqual([c.pid]);
    expect(alive(c.pid!)).toBe(true);
  });

  it("повторно використаний PID (інше comm при тому самому start) → не вбиваємо", async () => {
    const c = start();
    const t = track(c);
    const owner = await deadOwner();
    const file = path.join(dir, "d.json");
    writePidFile(file, { owner: "worker", pid: owner.pid, start: owner.start, written_at: "", children: [{ ...t, comm: "postgres" }] });
    const rep = cleanupOrphansFromFile(file);
    expect(rep.killed).toEqual([]);
    expect(alive(c.pid!)).toBe(true);
  });

  it("немає файлу → порожній звіт", () => {
    expect(cleanupOrphansFromFile(path.join(dir, "nope.json")).killed).toEqual([]);
  });

  it("survivors(): бачить живих записаних дітей, після вбивства — 0", async () => {
    const c = start();
    const file = path.join(dir, "e.json");
    writePidFile(file, newPidFile("worker", process.pid, [track(c)]));
    expect(survivors(file).map((s) => s.pid)).toEqual([c.pid]);
    process.kill(c.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
    expect(survivors(file)).toEqual([]);
  });
});

describe("descendantsOf", () => {
  it("знаходить онуків (sh → sleep), не знаходить чужих", async () => {
    const sh = spawn("/bin/sh", ["-c", `${decoyBin} 300 & wait`], { stdio: "ignore" });
    spawned.push(sh);
    await new Promise((r) => setTimeout(r, 250));
    const d = descendantsOf(process.pid);
    expect(d).toContain(sh.pid);
    const grand = d.filter((p) => readStat(p)?.ppid === sh.pid);
    expect(grand.length).toBe(1);
    expect(descendantsOf(999999)).toEqual([]);
  });
});

describe("зомбі", () => {
  it("isSameProc: процес, що вийшов, але не прибраний батьком (зомбі), — НЕ живий; живий процес — живий (контроль)", async () => {
    // sh запускає true у фоні й exec-иться в sleep: sleep не робить wait → true лишається зомбі
    const sh = spawn("/bin/sh", ["-c", "/bin/true & exec /bin/sleep 30"], { stdio: "ignore" });
    spawned.push(sh);
    let z: number | undefined;
    for (let i = 0; i < 100 && z === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
      z = descendantsOf(sh.pid!).find((p) => readStat(p)?.state === "Z");
    }
    expect(z, "зомбі виник").toBeDefined();
    expect(isSameProc({ pid: z!, start: procStart(z!) })).toBe(false);
    expect(isSameProc({ pid: sh.pid!, start: procStart(sh.pid!) })).toBe(true);
  });
});
