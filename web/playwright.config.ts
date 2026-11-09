import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const windowsBrowser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  outputDir: './test-results',
  reporter: 'list',
  use: {
    viewport: { width: 1440, height: 1100 },
    headless: true,
    launchOptions: { executablePath: process.env.COREPILOT_BROWSER_PATH ?? windowsBrowser },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
