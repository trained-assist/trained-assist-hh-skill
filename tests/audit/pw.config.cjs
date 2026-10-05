const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: '.', testMatch: '**/*.spec.cjs', timeout: 60000, workers: 1, retries: 0, reporter: [['list']], use: { browserName: 'chromium', headless: true } });
