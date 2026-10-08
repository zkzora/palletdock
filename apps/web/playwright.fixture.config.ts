import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E against the isolated fixture stack (pnpm e2e:stack). The stack
 * uses a local Hardhat chain, so these runs verify workflows, not the live
 * Portaldot network.
 */
const statePath = path.resolve(import.meta.dirname, '../../.data/e2e/state.json');
let baseURL = 'http://127.0.0.1:3199';
try {
  baseURL = JSON.parse(readFileSync(statePath, 'utf8')).webUrl;
} catch {
  /* stack not running: tests will fail fast with a clear message */
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /fixture-.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  retries: 0,
  workers: 1,
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report-fixture' }]],
  use: { baseURL, channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 30_000, navigationTimeout: 120_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1280, height: 860 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', channel: 'chrome' } },
  ],
});
