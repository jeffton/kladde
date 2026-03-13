import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(clientDir, "..");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "./client/scripts/run-playwright-server.sh",
    cwd: repoRoot,
    url: "http://127.0.0.1:8080/api/health",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
});
