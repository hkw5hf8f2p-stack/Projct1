/** pnpm slice — прогін зрізу на fixtures/slice/{defective,clean}.html → planning/qa/artifacts/sprint-1a/slice/<page>/ */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureSlice, secureLaunch, serveDir } from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const server = await serveDir(path.join(ROOT, "fixtures/slice"));
const secure = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [server.origin] });
try {
  for (const name of ["defective", "clean"]) {
    const outDir = path.join(ROOT, "planning/qa/artifacts/sprint-1a/slice", name);
    const r = await captureSlice({ url: `${server.origin}/${name}.html`, outDir, secure });
    console.log(name, JSON.stringify(r.detector_summary), `evidence=${r.evidence.length}`);
  }
} finally {
  await secure.close();
  await server.close();
}
