const { defineConfig } = require('@playwright/test');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
module.exports = defineConfig({ testDir: './tests/staging', testMatch: '**/*.spec.cjs',
  timeout: 45_000, workers: 1, retries: 0, forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { browserName: 'chromium', headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
});
