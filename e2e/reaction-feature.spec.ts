import { expect, test } from '@playwright/test';

for (const mode of ['Guess nearby', 'Guess aggressively']) {
  test(`${mode} shows progress and Refresh during a cold scan with an already-open chat`, async ({ page }) => {
    await page.addInitScript(() => {
      const directory = (name: string, children: Record<string, any>): any => ({
        kind: 'directory', name,
        async getDirectoryHandle(key: string) { if (children[key]?.kind === 'directory') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
        async getFileHandle(key: string) { if (children[key]?.kind === 'file') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
        async *entries() { yield* Object.entries(children); },
      });
      const chats: Record<string, any> = {};
      for (const actor of ['Alice', 'Bob', 'Charlie']) {
        const messages = [
          ...Array.from({ length: 8 }, (_, i) => ({ sender_name: 'Owner', timestamp_ms: 1_700_000_000_000 + i, content: `target ${i}`, reactions: [{ actor, reaction: '\u{1f602}' }] })),
          ...Array.from({ length: 8 }, (_, i) => ({ sender_name: actor, timestamp_ms: 1_700_000_001_000 + i, content: `${actor} reacted \u{1f602} to your message` })),
        ];
        const contents = JSON.stringify({ title: `${actor} Chat`, thread_path: `inbox/${actor}`, participants: [{ name: 'Owner' }, { name: actor }], messages: messages.reverse() });
        chats[actor] = directory(actor, { 'message_1.json': { kind: 'file', name: 'message_1.json', async getFile() { return new File([contents], 'message_1.json'); } } });
      }
      localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
      localStorage.setItem(`majv_${location.hostname}_setting_reactionTimestampGuessingMode`, 'off');
      Object.defineProperty(window, 'showDirectoryPicker', { value: async () => directory('messages', { inbox: directory('inbox', chats) }), configurable: true });
      const Original = window.Worker;
      (window as any).__reactionWorkers = 0;
      (window as any).__holdReactionThread = true;
      window.Worker = class extends Original {
        private audit: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.audit = String(url).includes('reactionAuditWorker');
          if (this.audit) {
            (window as any).__reactionWorkers++;
            delete (window as any).__releaseReactionThread;
          }
        }
        postMessage(input: any) {
          if (this.audit && input.type === 'thread' && (window as any).__holdReactionThread) {
            (window as any).__releaseReactionThread = () => {
              (window as any).__holdReactionThread = false;
              super.postMessage(input);
            };
          } else super.postMessage(input);
        }
      };
    });
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
    await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Reaction timestamp matching', exact: true }).click();
    await page.getByRole('option', { name: mode, exact: true }).click();
    const status = page.locator('.reaction-guessing-status');
    await expect(status.getByRole('status')).toHaveText('Checking reaction notices…');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseReactionThread)).toBe('function');
    await page.getByRole('button', { name: 'Reaction timestamp matching', exact: true }).click();
    await page.getByRole('option', { name: "Don't guess", exact: true }).click();
    await expect(status.getByRole('status')).toHaveText('No guesses cached');
    await expect(status.getByRole('button', { name: 'Clear', exact: true })).toBeEnabled();
    await expect(status.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Reaction timestamp matching', exact: true }).click();
    await page.getByRole('option', { name: mode, exact: true }).click();
    expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(1);
    await status.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__reactionWorkers)).toBe(2);
    // Wait for the restarted worker's request before releasing the held input.
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseReactionThread)).toBe('function');
    await page.evaluate(() => (window as any).__releaseReactionThread());
    await expect(status.getByRole('status')).toHaveText('Guesses Available');
    await page.locator('.reaction-bubble').last().click();
    await expect(page.locator('.modal-actor')).toHaveAttribute('title', /^~ [^~]/);
  });
}

test('nearby completes delayed reaction pairs and closes the extended block', async ({ page }) => {
  await page.addInitScript(() => {
    const base = 1_700_000_000_000, late = base + 31 * 60_000, emoji = '\u{1f602}';
    const directory = (name: string, children: Record<string, any>): any => ({
      kind: 'directory', name,
      async getDirectoryHandle(key: string) { if (children[key]?.kind === 'directory') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
      async getFileHandle(key: string) { if (children[key]?.kind === 'file') return children[key]; throw new DOMException('Missing', 'NotFoundError'); },
      async *entries() { yield* Object.entries(children); },
    });
    const conversations: Record<string, any> = {};
    for (const [actor, count] of [['Alice', 5], ['Bob', 8], ['Charlie', 7]] as const) {
      const target = (timestamp_ms: number, content: string) => ({ sender_name: 'Owner', timestamp_ms, content, reactions: [{ actor, reaction: emoji }] });
      const notice = (timestamp_ms: number) => ({ sender_name: actor, timestamp_ms, content: `${actor} reacted ${emoji} to your message` });
      const messages = actor === 'Alice' ? [
        target(base + 1, 'first delayed target'), target(base + 2, 'second delayed target'), notice(base + 3),
        { sender_name: actor, timestamp_ms: late, content: 'reply after the gap' }, notice(late + 1), notice(late + 2),
        target(late + 3, 'later target one'), target(late + 4, 'later target two'), notice(late + 5), notice(late + 6),
      ] : [
        ...Array.from({ length: count }, (_, i) => target(base + i + 1, `target ${i}`)),
        ...Array.from({ length: count }, (_, i) => notice(late + i)),
      ];
      const contents = JSON.stringify({ title: `${actor} Chat`, thread_path: `inbox/${actor}`, participants: [{ name: 'Owner' }, { name: actor }], messages: messages.reverse() });
      conversations[actor] = directory(actor, { 'message_1.json': { kind: 'file', name: 'message_1.json', async getFile() { return new File([contents], 'message_1.json'); } } });
    }
    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => directory('messages', { inbox: directory('inbox', conversations) }), configurable: true });
  });
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Reaction timestamp matching', exact: true })).toContainText('Guess aggressively');
  await page.getByRole('button', { name: 'Reaction timestamp matching', exact: true }).click();
  await page.getByRole('option', { name: 'Guess nearby', exact: true }).click();
  await expect(page.getByText('Guesses Available', { exact: true })).toBeVisible();
  for (const index of [0, 1]) {
    await page.locator(`.message[data-msg-index="${index}"] .reaction-bubble`).click();
    await expect(page.locator('.modal-time')).toHaveText(/^~ [^~]/);
    await expect(page.locator('.modal-actor')).toHaveAttribute('title', /^~ [^~]/);
    await expect(page.locator('.modal-actor')).toHaveCSS('color', 'rgb(62, 166, 255)');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const hiddenNotice = page.getByRole('region', { name: 'Hidden reaction notices', exact: true });
  await page.locator('label[for="hideLikelyReactionNotices"]').click();
  await expect(hiddenNotice).toHaveCount(0);
  await page.locator('label[for="hideLikelyReactionNotices"]').click();
  await expect(hiddenNotice).toContainText('5 reaction notices hidden');
  await page.setViewportSize({ width: 390, height: 844 });
  await hiddenNotice.scrollIntoViewIfNeeded();
  const noticeBox = await hiddenNotice.boundingBox();
  const chatBox = await page.locator('.chat-container').boundingBox();
  expect(noticeBox!.x).toBeGreaterThanOrEqual(chatBox!.x);
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width);
  await page.screenshot({ path: test.info().outputPath('reaction-controls-mobile.png') });
  const scrollTop = await page.locator('#chat').evaluate(el => el.scrollTop);
  await expect(hiddenNotice).toHaveCount(0, { timeout: 5000 });
  expect(await page.locator('#chat').evaluate(el => el.scrollTop)).toBe(scrollTop);
});

test('reaction hints dismiss and timestamped names show blue hover dates across guessing modes', async ({ page }) => {
  await page.addInitScript(() => {
    const base = 1_700_000_000_000, emoji = '\u{1f602}';
    const makeDirectory = (name: string, children: Record<string, any>): any => ({
      kind: 'directory', name,
      async getDirectoryHandle(key: string) { const child = children[key]; if (child?.kind === 'directory') return child; throw new DOMException('Missing', 'NotFoundError'); },
      async getFileHandle(key: string) { const child = children[key]; if (child?.kind === 'file') return child; throw new DOMException('Missing', 'NotFoundError'); },
      async *entries() { for (const entry of Object.entries(children)) yield entry; },
    });
    const conversations: Record<string, any> = {};
    for (const [actor, count] of [['Alice', 10], ['Bob', 5], ['Charlie', 5]] as const) {
      const messages: any[] = [];
      if (actor === 'Alice') {
        messages.push(...[1, 2].map(i => ({ sender_name: 'Owner', timestamp_ms: base - 60 * 86400000 + i, content: `old target ${i}`, reactions: [{ actor, reaction: emoji }] })));
        messages.push(...Array.from({ length: 300 }, (_, i) => ({ sender_name: 'Owner', timestamp_ms: base + i, content: `history ${i}` })));
      }
      for (let i = 0; i < count; i++) messages.push({ sender_name: 'Owner', timestamp_ms: base + 1000 + i, content: `target ${i}`, reactions: [{ actor: 'Ghost', reaction: '❤️', timestamp: 1700000000 }, { actor, reaction: emoji }] });
      for (let i = 0; i < count + (actor === 'Alice' ? 2 : 0); i++) {
        messages.push({ sender_name: actor, timestamp_ms: base + 2000 + 2 * i, content: `Wrong text name reacted ${emoji} to your message` });
        messages.push({ sender_name: actor, timestamp_ms: base + 2001 + 2 * i, content: `reply ${i}` });
      }
      const contents = JSON.stringify({ title: `${actor} Chat`, thread_path: `inbox/${actor}`, participants: [{ name: 'Owner' }, { name: actor }], messages: messages.reverse() });
      conversations[actor] = makeDirectory(actor, { 'message_1.json': { kind: 'file', name: 'message_1.json', async getFile() { return new File([contents], 'message_1.json'); } } });
    }
    const root = makeDirectory('messages', { inbox: makeDirectory('inbox', conversations) });
    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_reactionTimestampGuessingMode`, 'off');
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => root, configurable: true });
    const BrowserWorker = window.Worker;
    (window as any).__reactionWorkers = 0;
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); if (String(url).includes('reactionAuditWorker')) (window as any).__reactionWorkers++; }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#chat')).not.toContainText('reacted');
  expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(0);
  const hiddenNotice = page.getByRole('region', { name: 'Hidden reaction notices', exact: true });
  await expect(hiddenNotice).toContainText('12 reaction notices hidden');
  await expect(hiddenNotice.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
  await expect(page.locator('.chat-header .reaction-hidden-control')).toHaveCount(0);
  await expect(hiddenNotice.locator('[title]')).toHaveCount(0);
  const headerBox = await page.locator('.chat-view-layer.active > .chat-header').boundingBox();
  const noticeBox = await hiddenNotice.boundingBox();
  expect(noticeBox!.y).toBeGreaterThan(headerBox!.y + headerBox!.height);
  await expect(hiddenNotice).toHaveCount(0, { timeout: 5000 });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const selector = page.getByRole('button', { name: 'Reaction timestamp matching', exact: true });
  await selector.click();
  await expect(page.getByRole('listbox', { name: 'Reaction timestamp matching' }).locator('input')).toHaveCount(0);
  await page.getByRole('option', { name: 'Guess nearby', exact: true }).click();
  await expect(page.getByText('Guesses Available', { exact: true })).toBeVisible();
  const guessingStatus = page.locator('.reaction-guessing-status');
  const refresh = guessingStatus.getByRole('button', { name: 'Refresh', exact: true });
  const statusBox = await guessingStatus.getByRole('status').boundingBox();
  const refreshBox = await refresh.boundingBox();
  expect(refreshBox!.x).toBeGreaterThan(statusBox!.x + statusBox!.width);
  expect(Math.abs(refreshBox!.y + refreshBox!.height / 2 - statusBox!.y - statusBox!.height / 2)).toBeLessThan(1);
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).__reactionWorkers)).toBe(2);
  await expect(page.getByText('Guesses Available', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('reaction-controls-desktop.png') });
  const bubble = page.locator('.reaction-bubble').last();
  await bubble.hover();
  const localName = bubble.locator('.popover-actor').filter({ hasText: 'Alice' });
  const recordedName = bubble.locator('.popover-actor').filter({ hasText: 'Ghost' });
  await expect(localName).toHaveAttribute('title', /^~ [^~]/);
  await expect(localName).toHaveCSS('color', 'rgb(62, 166, 255)');
  await expect(recordedName).toHaveAttribute('title', /^[^~]/);
  await expect(recordedName).toHaveCSS('color', 'rgb(62, 166, 255)');
  const localTime = await localName.getAttribute('title');
  await bubble.click();
  await page.locator('.reaction-tab').filter({ hasText: '\u{1f602}' }).click();
  await expect(page.locator('.modal-time')).toHaveCount(1);
  await expect(page.locator('.modal-time')).toHaveText(/^~ [^~]/);
  expect(await page.locator('.modal-time').getAttribute('title')).toBeNull();
  await expect(page.locator('.modal-actor')).toHaveAttribute('title', localTime!);
  await expect(page.locator('.modal-actor')).toHaveCSS('color', 'rgb(62, 166, 255)');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(hiddenNotice).toHaveCount(0);
  // Both selectors share the presentation classes; timestamp mode does not reset scroll.
  const before = await page.locator('#chat').evaluate(el => el.scrollTop);
  await selector.click();
  await page.getByRole('option', { name: 'Guess aggressively', exact: true }).click();
  await expect(page.getByText('Guesses Available', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(2);
  expect(await page.locator('#chat').evaluate(el => el.scrollTop)).toBe(before);
  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('old target 2'); await search.press('Enter');
  await page.getByRole('listbox', { name: 'Search results' }).getByRole('option').click();
  const oldBubble = page.locator('.message[data-msg-index="1"] .reaction-bubble');
  await oldBubble.hover();
  await expect(oldBubble.locator('.popover-actor')).toHaveAttribute('title', /^~~ /);
  await expect(oldBubble.locator('.popover-actor')).toHaveCSS('color', 'rgb(62, 166, 255)');
  await oldBubble.click();
  await expect(page.locator('.modal-actor')).toHaveAttribute('title', /^~~ /);
  await expect(page.locator('.modal-time')).toHaveText(/^~~ /);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  // Search can still reveal notices after the floating hint has disappeared.
  await search.fill('reacted'); await search.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('No results');
  await page.locator('.reaction-search-hint').getByRole('button', { name: 'Show all', exact: true }).click();
  await expect(hiddenNotice).toHaveCount(0);
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('reacted');
  await expect(page.locator('#chat')).toContainText('reacted');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 440 });
  const readingRow = page.locator('#chat .message[data-msg-index="313"]');
  await readingRow.scrollIntoViewIfNeeded();
  await page.locator('#chat').evaluate(el => {
    const row = el.querySelector<HTMLElement>('.message[data-msg-index="313"]')!;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 40;
    el.dispatchEvent(new Event('scroll'));
  });
  const offset = await readingRow.evaluate(el => el.getBoundingClientRect().top - document.getElementById('chat')!.getBoundingClientRect().top);
  await page.locator('label[for="hideLikelyReactionNotices"]').click();
  await expect(page.locator('#chat')).not.toContainText('reacted');
  await expect(hiddenNotice).toContainText('12 reaction notices hidden');
  expect(Math.abs(await readingRow.evaluate(el => el.getBoundingClientRect().top - document.getElementById('chat')!.getBoundingClientRect().top) - offset)).toBeLessThan(2);
  await selector.click();
  await page.getByRole('option', { name: "Don't guess", exact: true }).click();
  await expect(guessingStatus.getByRole('status')).toHaveText('Guesses cached');
  await expect(guessingStatus.getByRole('button', { name: 'Clear', exact: true })).toBeEnabled();
  await expect(guessingStatus.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await page.locator('.reaction-bubble').last().click();
  await page.locator('.reaction-tab').filter({ hasText: '\u{1f602}' }).click();
  await expect(page.locator('.modal-time')).toHaveCount(0);
  await expect(page.locator('.modal-actor')).not.toHaveAttribute('title');
  await expect(page.locator('.modal-actor')).not.toHaveClass(/has-time-info/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.reaction-bubble').last().hover();
  await expect(localName).not.toHaveAttribute('title');
  await expect(localName).not.toHaveClass(/has-time-info/);
  await expect(recordedName).toHaveAttribute('title', /^[^~]/);
  // Off retains the completed audit, hides estimates and leaves Clear visible.
  // Re-enabling Nearby restores timestamps without another worker/scan.
  for (let attempt = 0; attempt < 2; attempt++) {
    await selector.click();
    await page.getByRole('option', { name: 'Guess nearby', exact: true }).click();
    await expect(page.getByText('Guesses Available', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(2);
    await page.locator('.reaction-bubble').last().hover();
    await expect(localName).toHaveAttribute('title', /^~ [^~]/);
    await expect(localName).toHaveCSS('color', 'rgb(62, 166, 255)');
    await expect(recordedName).toHaveAttribute('title', /^[^~]/);
    await selector.click();
    await page.getByRole('option', { name: "Don't guess", exact: true }).click();
    await expect(guessingStatus.getByRole('status')).toHaveText('Guesses cached');
    await page.locator('.reaction-bubble').last().hover();
    await expect(localName).not.toHaveAttribute('title');
  }
  await guessingStatus.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(guessingStatus.getByRole('status')).toHaveText('No guesses cached');
  await expect(guessingStatus.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(2);
  await page.locator('.reaction-bubble').last().hover();
  await expect(localName).not.toHaveAttribute('title');
  await expect(recordedName).toHaveAttribute('title', /^[^~]/);
  await selector.click();
  await page.getByRole('option', { name: 'Guess nearby', exact: true }).click();
  await expect(guessingStatus.getByRole('status')).toHaveText('Guesses Available');
  expect(await page.evaluate(() => (window as any).__reactionWorkers)).toBe(3);
  await page.locator('.reaction-bubble').last().hover();
  await expect(localName).toHaveAttribute('title', /^~ [^~]/);
  expect(errors).toEqual([]);
});
