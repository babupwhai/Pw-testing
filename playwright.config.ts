import { defineConfig } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "./tests/smoke",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"],
    },
  },
  webServer: {
    command: "pnpm run start",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    url: `http://127.0.0.1:${port}/auth`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});