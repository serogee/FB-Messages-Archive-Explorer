import { expect, test } from '@playwright/test';
import { installArchive } from './helpers/archive';

test('animates desktop chat loading without replacing the chat-list preview', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(alice).toBeVisible();
  const preview = await alice.locator('.chat-item-preview').textContent();
  await page.evaluate(() => {
    const fixture = window as unknown as { releaseChatParsing?: () => void };
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      private readonly chatParser: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.chatParser = String(url).includes('parserWorker');
      }
      postMessage(message: unknown, transfer: Transferable[] = []) {
        if (this.chatParser) fixture.releaseChatParsing = () => super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  await alice.click();
  const progress = page.getByRole('progressbar', { name: 'Chat loading progress' });
  await expect(progress).toBeVisible();
  const loading = page.locator('.load-progress-label');
  const spinner = loading.locator('.loading-spinner');
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    await expect(spinner).toHaveCSS('animation-name', 'loading-spin');
    const transform = await spinner.evaluate(element => getComputedStyle(element).transform);
    await expect.poll(() => spinner.evaluate(element => getComputedStyle(element).transform)).not.toBe(transform);
  }
  const dots = loading.locator('.loading-dots');
  const clip = await dots.evaluate(element => getComputedStyle(element).clipPath);
  await expect.poll(() => dots.evaluate(element => getComputedStyle(element).clipPath), { intervals: [80] }).not.toBe(clip);
  await expect(alice).toHaveAttribute('aria-busy', 'true');
  await expect(alice.locator('.chat-item-preview')).toHaveText(preview!);
  await expect(alice.locator('.loading-spinner')).toHaveCount(0);
  await expect(alice).not.toContainText('Loading chat');
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseChatParsing?: () => void }).releaseChatParsing)).toBe('function');
  await page.evaluate(() => (window as unknown as { releaseChatParsing: () => void }).releaseChatParsing());
  await expect(page.locator('#chat')).toContainText('needle from Facebook');
  await expect(progress).toHaveCount(0);
  await expect(alice).not.toHaveAttribute('aria-busy', 'true');
  await expect(alice.locator('.chat-item-preview')).toHaveText(preview!);
});
