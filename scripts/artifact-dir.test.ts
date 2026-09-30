import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactDir, REPO_ROOT } from "./artifact-dir.js";

describe("artifactDir (X-1): запис у закомічені артефакти лише з SL_WRITE_ARTIFACTS=1", () => {
  it("без прапорця → os.tmpdir(), не репо; з прапорцем → planning/qa/artifacts (контроль: шлях у репо)", () => {
    const off = artifactDir("sprint-1b/ssrf", {});
    const on = artifactDir("sprint-1b/ssrf", { SL_WRITE_ARTIFACTS: "1" });
    expect(off.startsWith(os.tmpdir() + path.sep)).toBe(true);
    expect(off.startsWith(REPO_ROOT)).toBe(false);
    expect(on).toBe(path.join(REPO_ROOT, "planning/qa/artifacts/sprint-1b/ssrf"));
    expect(artifactDir("x", { SL_WRITE_ARTIFACTS: "true" }).startsWith(REPO_ROOT)).toBe(false); // лише рівно "1"
  });
  it("відносний шлях без '..'", () => {
    expect(() => artifactDir("../../etc", { SL_WRITE_ARTIFACTS: "1" })).toThrow();
    expect(() => artifactDir("/abs", {})).toThrow();
  });
});
