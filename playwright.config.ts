import { defineConfig } from "@playwright/test";

// Browser E2E against the real server and real models (costs a few cents per run).
// Records a video of the whole walkthrough into test-results/.
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    video: { mode: "on", size: { width: 1280, height: 800 } },
    launchOptions: { slowMo: 120 },
  },
  // Seed first (fresh quotas), then boot in demo mode so the console hands out tenant keys itself.
  // Not reused: an already-running server may not be in demo mode, and the seed revokes its demo keys.
  webServer: {
    command: "npx tsx --env-file=.env scripts/seed.ts > /dev/null && DEMO_MODE=1 npx tsx --env-file=.env server/src/index.ts",
    url: "http://localhost:3000/healthz",
    reuseExistingServer: false,
  },
});
