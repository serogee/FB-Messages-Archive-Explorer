import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/FB-Messages-Archive-Explorer/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: '**/mobile-navigation.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-webkit', testMatch: '**/chat-header.spec.ts', grep: /pinned compact|crowded desktop/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', testMatch: '**/mobile-navigation.spec.ts', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'mobile-webkit', testMatch: '**/mobile-navigation.spec.ts', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
