// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT || 3456);
const BASE_URL = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // the mock server keeps state in memory; tests reset it between cases
  retries: 0, // flaky tests should be fixed and reported, not hidden by silent retries
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    // Optional: use a locally installed Chromium instead of the one Playwright downloads
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },

  // Starts the mock backend + web form automatically before the tests
  webServer: {
    command: 'node mock-server/server.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI && !process.env.MOCK_BUG,
    env: { PORT: String(PORT), MOCK_BUG: process.env.MOCK_BUG || '' },
    timeout: 30_000,
  },

  projects: [
    { name: 'unit', testDir: './tests/unit' },          // schema contract + HFC engine (no browser)
    { name: 'api', testDir: './tests/api' },            // Scenario A: POST /sync-survey
    {
      name: 'web',
      testDir: './tests/web',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Same skip-logic suite on a small, low-end Android-sized viewport
      name: 'web-mobile',
      testDir: './tests/web',
      use: { ...devices['Galaxy S5'] , browserName: 'chromium' },
    },
  ],
});
