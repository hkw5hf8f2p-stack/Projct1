import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // браузерні тести ділять один Chromium-профіль на файл, але файли незалежні
    pool: "forks",
  },
});
