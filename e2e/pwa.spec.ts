import { expect, test } from '@playwright/test';

test('default offline support caches the app and disabling it preserves unrelated caches', async ({ page, context }) => {
  test.skip(!process.env.E2E_PRODUCTION, 'Service workers are disabled on the development server.');
  await page.goto('');
  await page.getByRole('dialog', { name: 'Privacy & Trust Notice' }).getByRole('button', { name: 'Got it' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Ready for offline use' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss offline-ready notification' }).click();
  await expect(notice).toBeHidden();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    await caches.open('unrelated-e2e-cache');
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /Select messages folder|Select folder/ })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const offlineToggle = page.getByRole('checkbox', { name: 'Keep app available offline' });
  await expect(offlineToggle).toBeChecked();
  await page.locator('label[for="offlineSupportEnabledToggle"]').click();
  const confirmation = page.getByRole('dialog', { name: 'Disable offline support?' });
  await confirmation.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(offlineToggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope),
    caches: await caches.keys(),
  }))).toEqual({ registrations: [], caches: ['unrelated-e2e-cache'] });

  // A reload must not register another worker when the preference is disabled.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(offlineToggle).not.toBeChecked();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect(notice).toBeHidden();
});
