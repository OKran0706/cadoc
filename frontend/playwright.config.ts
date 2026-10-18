import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, workers: 1,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000', browserName: 'chromium', channel: 'msedge', headless: true, viewport: {width:1280,height:900}, permissions:['clipboard-read','clipboard-write'], reducedMotion:'reduce', screenshot:'only-on-failure' },
  reporter: [['list']],
});
