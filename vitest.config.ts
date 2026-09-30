import { defineConfig } from "vitest/config";

import os from "node:os";
import path from "node:path";

export default defineConfig({
  cacheDir: path.join(os.tmpdir(), "sitelens-vite-cache"),
  test: {
    globalSetup: ["./scripts/vitest-global-setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // браузерні тести ділять один Chromium-профіль на файл, але файли незалежні
    pool: "forks",
  },
});
