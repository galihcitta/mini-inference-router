import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:mir@localhost:55432/mir_test", LOG_LEVEL: "silent" },
    fileParallelism: false,
    testTimeout: 15000,
  },
});
