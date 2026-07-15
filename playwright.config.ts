import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/globalSetup.ts',
  timeout: 60_000,
  retries: 1,
  // Try Out tests are one giant describe block with a test() per scraped
  // request — fullyParallel distributes those across workers (otherwise
  // they'd still run serially within the single file despite `workers`).
  // Capped at 3, not higher: some Try Out requests are Create/Update/Delete
  // calls that mutate the real QA stack, so too much concurrency risks the
  // same write races flagged for cross-module parallelism.
  fullyParallel: true,
  workers: 3,
  reporter: [
    ['html', { outputFolder: 'reports/playwright', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['list'],
  ],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    baseURL: 'https://www.contentstack.com',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
