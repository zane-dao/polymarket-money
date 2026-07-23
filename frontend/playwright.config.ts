import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.POLYMARKET_E2E_PORT ?? "4174", 10);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("POLYMARKET_E2E_PORT must be a valid unprivileged TCP port");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "/tmp/polymarket-money-playwright/results",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npm run frontend:build && POLYMARKET_DATA_ROOT=/tmp/polymarket-money-web-e2e POLYMARKET_WEB_PORT=${port} node dist/scripts/workbench-web-server.js`,
    cwd: new URL("..", import.meta.url).pathname,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
