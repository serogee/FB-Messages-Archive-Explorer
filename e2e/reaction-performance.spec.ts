import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('dense notice histories stay bounded when opening and toggling visibility', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const count = Number(process.env.REACTION_PERF_COUNT || 20_000);
  await page.addInitScript(({ count }) => {
    const base = 1_700_000_000_000;
    const perf = (window as any).__reactionPerformance = { tasks: [] as { start: number; duration: number }[], parserComplete: 0 };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) perf.tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('parserWorker')) this.addEventListener('message', () => { perf.parserComplete = performance.now(); });
      }
    };
    const messages = [
      { sender_name: 'Owner', timestamp_ms: base, content: 'first ordinary message' },
      ...Array.from({ length: count }, (_, i) => ({ sender_name: 'Alice', timestamp_ms: base + i + 1, content: 'Alice reacted 😂 to your message' })),
      { sender_name: 'Owner', timestamp_ms: base + count + 1, content: 'last ordinary message' },
    ];
    const contents = JSON.stringify({ title: 'Dense Chat', thread_path: 'inbox/dense', participants: [{ name: 'Owner' }, { name: 'Alice' }], messages: messages.reverse() });
    const directory = (name: string, children: Record<string, any>): any => ({
      kind: 'directory', name,
      async getDirectoryHandle(key: string) { if (children[key]?.kind === 'directory') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
      async getFileHandle(key: string) { if (children[key]?.kind === 'file') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
      async *entries() { yield* Object.entries(children); },
    });
    const file = { kind: 'file', name: 'message_1.json', async getFile() { return new File([contents], 'message_1.json'); } };
    const root = directory('messages', { inbox: directory('inbox', { dense: directory('dense', { 'message_1.json': file }) }) });
    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => root, configurable: true });
  }, { count });
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const profiler = process.env.REACTION_PERF_PROFILE ? await page.context().newCDPSession(page) : null;
  if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
  const started = await page.evaluate(() => performance.now());
  await page.locator('.chat-list-item').filter({ hasText: 'Dense Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  const snapshot = async (start: number) => page.evaluate(async start => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const now = performance.now(), perf = (window as any).__reactionPerformance;
    return {
      elapsedMs: now - start, parserCompleteMs: perf.parserComplete >= start ? perf.parserComplete - start : undefined,
      messages: document.querySelectorAll('#chat .message[data-msg-index]').length,
      renderedChunks: document.querySelectorAll('#chat .message-chunk[data-rendered="true"]').length,
      longTasks: perf.tasks.filter((task: { start: number }) => task.start >= start),
    };
  }, start);
  const opened = await snapshot(started);
  console.log('Opened', JSON.stringify(opened));
  await writeFile(test.info().outputPath('reaction-performance.json'), JSON.stringify({ count, opened }, null, 2));
  await page.getByRole('tab', { name: 'Settings' }).click();
  const toggle = page.locator('label[for="hideLikelyReactionNotices"]');
  const showStarted = await page.evaluate(() => performance.now());
  await toggle.click();
  await expect(page.getByRole('checkbox', { name: 'Hide reaction notices', exact: true })).not.toBeChecked();
  await expect(page.locator(`#chat .message[data-msg-index="${count}"]`)).toBeVisible();
  const shown = await snapshot(showStarted);
  console.log('Shown', JSON.stringify(shown));
  await writeFile(test.info().outputPath('reaction-performance.json'), JSON.stringify({ count, opened, shown }, null, 2));
  const hideStarted = await page.evaluate(() => performance.now());
  await toggle.click();
  await expect(page.getByRole('checkbox', { name: 'Hide reaction notices', exact: true })).toBeChecked();
  await expect(page.locator(`#chat .message[data-msg-index="${count}"]`)).toHaveCount(0);
  const hidden = await snapshot(hideStarted);
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await writeFile(test.info().outputPath('reaction-profile.json'), JSON.stringify(profile));
  }
  const report = {
    environment: { browser: browser.version(), platform: process.platform, arch: process.arch, node: process.version, profile: !!profiler, storage: 'in-memory File/Directory handles', server: process.env.E2E_PRODUCTION ? 'Vite production preview' : 'Vite development' },
    count, opened, shown, hidden,
  };
  await writeFile(test.info().outputPath('reaction-performance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(shown.messages).toBeLessThan(500);
  expect(shown.renderedChunks).toBeLessThan(12);

  // Visiting distant chunks must release the previous rows and allow those
  // chunks to render again. Repeat the toggle after browsing the history.
  await toggle.click();
  for (const index of [50, 1000, 5000, 10000, 15000, 0, count]) {
    const chunkIndex = Math.floor(index / 50);
    await page.locator(`.message-chunk[data-chunk-index="${chunkIndex}"]`).evaluate(el => el.scrollIntoView({ block: 'start' }));
    await expect(page.locator(`#chat .message[data-msg-index="${index}"]`)).toBeVisible();
    await expect.poll(() => page.locator('#chat .message[data-msg-index]').count()).toBeLessThan(500);
    await expect.poll(() => page.locator('#chat .message-chunk[data-rendered="true"]').count()).toBeLessThan(12);
  }
  await toggle.click();
  await expect(page.locator('#chat .message[data-msg-index]')).toHaveCount(2);
});
