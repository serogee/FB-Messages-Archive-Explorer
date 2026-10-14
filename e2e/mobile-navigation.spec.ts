import { expect, test, type Locator, type Page } from '@playwright/test';
import { installArchive } from './helpers/archive';

// These workflows traverse multiple screens; Windows WebKit is slower than Chromium.
test.setTimeout(60_000);

async function openChat(page: Page, longMessages = 0, withValidImage = false, unavailableMedia = false) {
  await installArchive(page, 'facebook', false, unavailableMedia, false, longMessages);
  await page.goto('');
  if (withValidImage) {
    await page.evaluate(async () => {
      const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
      const inbox = await fixture.__testArchives.facebook.getDirectoryHandle('inbox');
      const alice = await inbox.getDirectoryHandle('alice_chat');
      const photos = await alice.getDirectoryHandle('photos');
      const file = await photos.getFileHandle('photo.jpg');
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 360;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#356a9e';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
      const writer = await file.createWritable();
      await writer.write(new Uint8Array(await png.arrayBuffer()));
      await writer.close();
    });
  }
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await expect(page.locator('#chat .message')).not.toHaveCount(0);
  await expectScreen(page, 'chat');
}

async function expectScreen(page: Page, screen: string) {
  await expect(page.locator('.container')).toHaveAttribute('data-mobile-screen', screen);
}

async function tapWithoutMovingFollowingMessages(page: Page, message: Locator) {
  await page.locator('#chat:not([data-opening="true"])').waitFor();
  await message.locator('.message-text').scrollIntoViewIfNeeded();
  const index = await message.getAttribute('data-msg-index');
  await page.evaluate(async index => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const chat = document.querySelector<HTMLElement>('#chat')!;
    const messages = [...chat.querySelectorAll<HTMLElement>('.message')];
    const viewport = chat.getBoundingClientRect();
    const following = messages.slice(messages.findIndex(element => element.dataset.msgIndex === index))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    const tapped = messages.find(element => element.dataset.msgIndex === index)!;
    const separators = [...chat.querySelectorAll<HTMLElement>('.time-separator:not(.mobile-msg-timestamp)')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return !!(tapped.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
          && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    const measure = () => ({
      chatWidth: chat.clientWidth,
      messages: following.map(element => {
        const rect = element.getBoundingClientRect();
        const text = element.querySelector('.message-text');
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        return {
          index: element.dataset.msgIndex, ...box(rect),
          lines: text ? [...range.getClientRects()].map(box) : [],
          reactions: [...element.querySelectorAll('.reaction-bubble, .reaction-emoji-simple, .reaction-count')]
            .map(element => box(element.getBoundingClientRect())),
        };
      }),
      separators: separators.map(element => {
        const rect = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        return { ...box(rect), lines: [...range.getClientRects()].map(box) };
      }),
    });
    const capture = { before: measure(), frames: [] as ReturnType<typeof measure>[], done: false };
    (window as unknown as { timestampStability: typeof capture }).timestampStability = capture;
    const sample = () => {
      capture.frames.push(measure());
      if (capture.frames.length >= 8) capture.done = true;
      else requestAnimationFrame(sample);
    };
    const observer = new MutationObserver(() => {
      observer.disconnect();
      sample();
    });
    observer.observe(chat, { subtree: true, attributes: true, attributeFilter: ['data-timestamp-visible'] });
  }, index);
  await message.locator('.message-text').tap();
  await page.waitForFunction(() => (window as unknown as { timestampStability: { done: boolean } }).timestampStability.done);
  const maximumDrift = await page.evaluate(() => {
    type Box = { x: number; y: number; width: number; height: number };
    type Snapshot = {
      chatWidth: number;
      messages: (Box & { index: string; lines: Box[]; reactions: Box[] })[];
      separators: (Box & { lines: Box[] })[];
    };
    const capture = (window as unknown as { timestampStability: { before: Snapshot; frames: Snapshot[] } }).timestampStability;
    let maximum = 0;
    const compare = (before: Box, after: Box) => {
      for (const key of ['x', 'y', 'width', 'height'] as const) maximum = Math.max(maximum, Math.abs(before[key] - after[key]));
    };
    for (const frame of capture.frames) {
      if (frame.chatWidth !== capture.before.chatWidth) return Infinity;
      for (const [index, before] of capture.before.messages.entries()) {
        const after = frame.messages[index];
        if (before.index !== after.index || before.lines.length !== after.lines.length || before.reactions.length !== after.reactions.length) return Infinity;
        compare(before, after);
        before.lines.forEach((line, index) => compare(line, after.lines[index]));
        before.reactions.forEach((reaction, index) => compare(reaction, after.reactions[index]));
      }
      for (const [index, before] of capture.before.separators.entries()) {
        const after = frame.separators[index];
        if (before.lines.length !== after.lines.length) return Infinity;
        compare(before, after);
        before.lines.forEach((line, index) => compare(line, after.lines[index]));
      }
    }
    return maximum;
  });
  expect(maximumDrift, 'Bubbles, text, reactions, and separators at or below the tapped message must stay still').toBeLessThanOrEqual(0.02);
}

async function captureRegionPaint(page: Page, boxes: { x: number; y: number; width: number; height: number }[]) {
  const png = (await page.screenshot({ scale: 'device', caret: 'hide' })).toString('base64');
  return page.evaluate(async ({ png, boxes }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return boxes.map(box => {
      const ratio = devicePixelRatio;
      const x = Math.ceil(box.x * ratio), y = Math.ceil(box.y * ratio);
      const width = Math.floor((box.x + box.width) * ratio) - x;
      const height = Math.floor((box.y + box.height) * ratio) - y;
      const pixels = context.getImageData(x, y, width, height).data;
      let hash = 2166136261;
      for (const value of pixels) hash = Math.imul(hash ^ value, 16777619) >>> 0;
      return { width, height, hash };
    });
  }, { png, boxes });
}

type BubblePaintBox = { x: number; y: number; width: number; height: number; color: number[] };

async function captureBubblePaint(page: Page, boxes: BubblePaintBox[]) {
  const top = Math.floor(boxes[0].y);
  const last = boxes.at(-1)!;
  const viewport = page.viewportSize()!;
  const clip = { x: 0, y: top, width: viewport.width, height: Math.ceil(last.y + last.height) - top };
  const png = (await page.screenshot({ clip, scale: 'device', caret: 'hide' })).toString('base64');
  return page.evaluate(async ({ png, clip, boxes }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const ratio = window.devicePixelRatio;
    const edges = boxes.map(box => {
      let top = Infinity;
      let bottom = -Infinity;
      const firstY = Math.max(0, Math.floor((box.y - clip.y) * ratio) - 1);
      const lastY = Math.min(canvas.height, Math.ceil((box.y + box.height - clip.y) * ratio) + 1);
      const firstX = Math.max(0, Math.floor(box.x * ratio));
      const lastX = Math.min(canvas.width, Math.ceil((box.x + box.width) * ratio));
      for (let y = firstY; y < lastY; y++) {
        for (let x = firstX; x < lastX; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (box.color.every((value, index) => Math.abs(value - pixels[offset + index]) <= 2)) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) throw new Error('Bubble fill or reaction border was missing from its screenshot region');
      return { top, bottom, height: bottom - top + 1 };
    });
    return edges.map((edge, index) => ({ ...edge, gapAfter: index + 1 < edges.length ? edges[index + 1].top - edge.bottom - 1 : null }));
  }, { png, clip, boxes });
}

async function openGallery(page: Page) {
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expectScreen(page, 'gallery');
}

async function viewerAction(page: Page, action: string) {
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
}

async function swipeViewer(page: Page, direction: 'left' | 'right', target = '.media-viewer-overlay', yFraction = 0.85) {
  const element = page.locator(target);
  const box = (await element.boundingBox())!;
  const startX = box.x + box.width * (direction === 'left' ? 0.8 : 0.2);
  const endX = box.x + box.width * (direction === 'left' ? 0.2 : 0.8);
  const y = box.y + box.height * yFraction;
  if (test.info().project.name.includes('chromium')) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
      for (let step = 1; step <= 4; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + (endX - startX) * step / 4, y }] });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    const pointer = { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0, clientY: y };
    await element.dispatchEvent('pointerdown', { ...pointer, clientX: startX });
    for (let step = 1; step <= 4; step++) {
      await element.dispatchEvent('pointermove', { ...pointer, clientX: startX + (endX - startX) * step / 4 });
    }
    await element.dispatchEvent('pointerup', { ...pointer, clientX: endX });
    // Synthetic pointer events do not create the compatibility click that a touch can emit.
    await page.locator('.media-viewer-overlay').dispatchEvent('click', { detail: 1 });
  }
}

async function holdChatRow(page: Page, title: string) {
  const row = page.locator('.chat-list-item').filter({ hasText: title });
  const box = (await row.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (test.info().project.name.includes('chromium')) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await expect(page.locator('.chat-item-dropdown')).toBeVisible();
    } finally {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    }
  } else {
    const pointer = { pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y };
    await row.dispatchEvent('pointerdown', pointer);
    await expect(page.locator('.chat-item-dropdown')).toBeVisible();
    await row.dispatchEvent('contextmenu');
    await row.dispatchEvent('pointerup', pointer);
    await row.dispatchEvent('click', { detail: 1 });
  }
}

test('opens mobile chat options with a hold and preserves ordinary taps and desktop buttons', async ({ page }) => {
  await openChat(page);
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).tap();
  await page.setViewportSize({ width: 320, height: 640 });
  const row = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(page.locator('.chat-item-menu-btn')).toHaveCount(0);
  const historyLength = await page.evaluate(() => history.length);
  await holdChatRow(page, 'Alice Chat');
  await expectScreen(page, 'home');
  await expect(row.locator('.chat-item-meta')).toHaveCSS('opacity', '1');
  const options = page.locator('.chat-item-dropdown');
  const bounds = (await options.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  await expect(options.getByRole('button', { name: 'Open JSON', exact: true })).toBeVisible();
  await expect(options.getByRole('button', { name: 'Copy folder path', exact: true })).toBeVisible();
  await expect(options.getByRole('button', { name: 'Delete chat', exact: true })).toBeVisible();
  await options.getByRole('button', { name: 'Pin to top', exact: true }).tap();
  await expect(row.getByLabel('Pinned chat', { exact: true })).toBeVisible();
  await expectScreen(page, 'home');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await holdChatRow(page, 'Alice Chat');
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await holdChatRow(page, 'Alice Chat');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'chat');
  await expect(options).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).tap();

  const pointer = { pointerId: 12, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 180 };
  await row.dispatchEvent('pointerdown', pointer);
  await row.dispatchEvent('pointermove', { ...pointer, clientY: 220 });
  await row.dispatchEvent('pointerup', { ...pointer, clientY: 220 });
  await row.dispatchEvent('click', { detail: 1 });
  await expectScreen(page, 'home');
  await expect(options).toHaveCount(0);
  await row.tap();
  await expectScreen(page, 'chat');
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).tap();
  await page.setViewportSize({ width: 1280, height: 844 });
  await row.hover();
  await expect(row.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Chat options', exact: true }).click();
  await expect(options.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
});

test('shows one mobile screen and distinguishes parent arrows from browser history', async ({ page }) => {
  await openChat(page);
  const chatBack = page.getByRole('button', { name: 'Back to chat list', exact: true });
  await expect(chatBack.locator('.parent-back-glyph')).toHaveAttribute('data-destination', 'chats');
  await expect(chatBack.locator('.parent-back-arrow')).toBeVisible();
  const chatBackBounds = (await chatBack.boundingBox())!;
  expect(chatBackBounds.width).toBe(44);
  expect(chatBackBounds.height).toBe(44);
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await expectScreen(page, 'info');
  const infoBack = page.getByRole('button', { name: 'Back to chat', exact: true });
  await expect(infoBack.locator('.parent-back-glyph')).toHaveAttribute('data-destination', 'chat');
  await expect(page.locator('.chat-container')).toBeHidden();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat info', exact: true }).click();
  await expectScreen(page, 'info');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'gallery');
  await page.evaluate(() => history.forward());
  await expectScreen(page, 'info');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).click();
  await expectScreen(page, 'home');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => history.back());
  await expect(page.getByRole('tab', { name: 'Chats', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => history.forward());
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('restores an attachment preview after jumping to its message', async ({ page }) => {
  await openChat(page);
  await openGallery(page);
  await page.locator('.gallery-thumb[title="photo.jpg"]').click();
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await viewerAction(page, 'Jump to message');
  await expectScreen(page, 'chat');
  await expect(page.locator('.media-viewer-overlay')).toHaveCount(0);
  await expect(page.locator('.message.highlight-target')).toBeVisible();
  await page.evaluate(() => history.back());
  await expectScreen(page, 'gallery');
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await expect(page.locator('.media-viewer-sender')).toHaveText('Alice');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.media-viewer-overlay')).toHaveCount(0);
  await expectScreen(page, 'gallery');
});

test('keeps gallery controls hidden when another mobile screen is active', async ({ page }) => {
  await openChat(page);
  await openGallery(page);
  await page.locator('.gallery-tab').filter({ hasText: 'Links' }).click();
  const card = page.locator('.gallery-thumb').first();
  await expect(card).toBeVisible();
  await expect(page.locator('.gallery-thumb .gallery-open-viewer-btn, .gallery-thumb .gallery-link-message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle attachment filters', exact: true }).click();
  const filters = page.locator('.gallery-filter-panel');
  await expect(filters).toBeVisible();

  await page.getByRole('button', { name: 'Back to chat info', exact: true }).click();
  await expectScreen(page, 'info');
  await expect(card).toBeHidden();
  await expect(filters).toBeHidden();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expectScreen(page, 'chat');
  await expect(card).toBeHidden();
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).click();
  await expectScreen(page, 'home');
  await expect(card).toBeHidden();
  await expect(filters).toBeHidden();

  await page.evaluate(() => history.back());
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expectScreen(page, 'gallery');
  await expect(card).toBeVisible();
  await expect(filters).toBeVisible();
});

test('restores a chat preview after jumping directly into the gallery, whose parent is info', async ({ page }) => {
  await openChat(page);
  await page.locator('#chat .lazy-media-wrapper').first().click();
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await viewerAction(page, 'Jump to attachment');
  await expectScreen(page, 'gallery');
  await expect(page.locator('.gallery-thumb.jump-highlight')).toBeVisible();
  await page.evaluate(() => history.back());
  await expectScreen(page, 'chat');
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await page.evaluate(() => history.forward());
  await expectScreen(page, 'gallery');
  await page.getByRole('button', { name: 'Back to chat info', exact: true }).click();
  await expectScreen(page, 'info');
});

test('returns to the exact message preview after a gallery jump without using its parent arrow', async ({ page }) => {
  await openChat(page);
  await page.locator('#chat .lazy-media-wrapper').first().click();
  const viewer = page.locator('.media-viewer-overlay');
  const date = (await viewer.locator('.media-viewer-date').textContent())!;
  await viewerAction(page, 'Jump to attachment');
  await expectScreen(page, 'gallery');
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Return to message', exact: true }).click();
  await expectScreen(page, 'chat');
  await expect(viewer.locator('.media-viewer-date')).toHaveText(date);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.evaluate(() => history.forward());
  await expectScreen(page, 'gallery');
  await expect(page.getByRole('button', { name: 'Return to message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss return action', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to message', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to chat info', exact: true }).click();
  await expectScreen(page, 'info');
});

test('reviews selected attachments full-screen and keeps the empty review navigable', async ({ page }) => {
  await openChat(page);
  await openGallery(page);
  await page.getByTitle('Select attachments and links', { exact: true }).click();
  await page.locator('.gallery-thumb[title="photo.jpg"]').click();
  await expect(page.locator('.mobile-selection-count')).toHaveText('1 selected');
  await page.getByRole('button', { name: 'Review selection', exact: true }).click();
  await expectScreen(page, 'selected');
  await expect(page.locator('.selection-panel')).toBeVisible();
  await expect(page.locator('.selection-panel-header')).toContainText('1 Selected');
  await page.locator('.selection-clear-btn').click();
  await expectScreen(page, 'selected');
  await expect(page.getByText('No attachments selected.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to attachments', exact: true }).click();
  await expectScreen(page, 'gallery');
});

test('keeps selection review on the right and mobile controls square at narrow widths', async ({ page }) => {
  await openChat(page, 0, false, true);
  await openGallery(page);
  const viewer = page.locator('.media-viewer-overlay');
  for (const tab of ['Links', 'Files']) {
    await page.locator('.gallery-tab').filter({ hasText: tab }).click();
    const card = page.locator('.gallery-thumb').first();
    await expect(card).toHaveAttribute('role', 'button');
    await expect(card.locator('.gallery-link-message, .gallery-open-viewer-btn')).toHaveCount(0);
    await card.click();
    await expect(viewer).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(viewer).toHaveCount(0);
  }
  await page.locator('.gallery-tab').filter({ hasText: 'Photos' }).click();
  await page.getByTitle('Select attachments and links', { exact: true }).click();
  await page.locator('.gallery-thumb').first().click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const review = page.getByRole('button', { name: 'Review selection', exact: true });
    const count = page.locator('.mobile-selection-count');
    await expect(count).toHaveText('1 selected');
    const bounds = (await review.boundingBox())!;
    const countBounds = (await count.boundingBox())!;
    expect(countBounds.x + countBounds.width).toBeLessThan(bounds.x);
    expect(bounds.width).toBeLessThan(width / 2);
    expect(bounds.x + bounds.width).toBeGreaterThan(width - 30);
    for (const selector of ['.gallery-back-btn', '.gallery-select-mode-toggle', '.gallery-filter-toggle', '#galleryInfoToggle']) {
      const button = page.locator(selector);
      await expect.poll(async () => Math.round((await button.boundingBox())!.width)).toBe(44);
      expect(Math.round((await button.boundingBox())!.height)).toBe(44);
      expect((await button.locator('svg').first().boundingBox())!.width).toBeGreaterThanOrEqual(16);
    }
    await expect(page.locator('.gallery-back-btn')).toHaveCSS('border-radius', '50%');
    await expect(page.locator('.gallery-back-btn .parent-back-glyph')).toHaveAttribute('data-destination', 'info');
    await expect(page.locator('.gallery-back-btn .parent-back-arrow')).toBeVisible();
    await expect(page.locator('.gallery-back-btn .parent-back-info')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button', { name: 'Review selection', exact: true }).click();
  for (const selector of ['.selection-panel .mobile-back-btn', '.selection-menu-btn', '.selection-clear-btn']) {
    const bounds = (await page.locator(selector).boundingBox())!;
    expect(bounds.width).toBe(44);
    expect(bounds.height).toBe(44);
  }
  await expect(page.locator('.selection-panel .parent-back-glyph')).toHaveAttribute('data-destination', 'attachments');
  await page.locator('.selection-panel .gallery-thumb').first().click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expectScreen(page, 'selected');
});

test('shows optional viewer navigation at the bottom on mobile and shares the preference with desktop', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page, 25, true);
  await openGallery(page);
  await page.locator('.gallery-thumb').first().click();
  const viewer = page.locator('.media-viewer-overlay');
  const image = viewer.locator('.media-viewer-image');
  const menu = viewer.getByRole('button', { name: 'More options', exact: true });
  const dropdown = viewer.locator('.media-viewer-menu-dropdown');
  await expect(viewer.locator('.media-viewer-navigation')).toHaveCount(0);
  const before = await viewer.locator('.media-viewer-date').textContent();
  const historyLength = await page.evaluate(() => history.length);
  await menu.click();
  await expect(dropdown.getByRole('button', { name: /Older item|Newer item|Previous item|Next item/ })).toHaveCount(0);
  await dropdown.getByRole('button', { name: 'Show Navigation', exact: true }).click();
  const controls = viewer.locator('.media-viewer-navigation');
  await expect(controls).toBeVisible();
  const footer = (await controls.boundingBox())!;
  expect(footer.y).toBeGreaterThan(844 - 90);
  await controls.getByRole('button', { name: 'Older item', exact: true }).tap();
  await expect(viewer.locator('.media-viewer-date')).not.toHaveText(before!);
  await controls.getByRole('button', { name: 'Newer item', exact: true }).tap();
  await expect(viewer.locator('.media-viewer-date')).toHaveText(before!);
  await expect(image).toHaveAttribute('aria-pressed', 'false');
  await image.tap();
  await expect(controls).toHaveAttribute('inert', '');
  await expect(controls).toHaveCSS('opacity', '0');
  await image.tap();
  await expect(controls).toHaveCSS('opacity', '1');
  await menu.click();
  await dropdown.getByRole('button', { name: 'Hide Navigation', exact: true }).click();
  await expect(controls).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(controls).toHaveCount(0);
  await menu.click();
  await dropdown.getByRole('button', { name: 'Show Navigation', exact: true }).click();
  await expect(controls).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(controls).toBeVisible();
  for (const button of await controls.getByRole('button').all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.height).toBe(44);
    expect(bounds.width).toBeGreaterThanOrEqual(96);
    expect(bounds.y).toBeGreaterThan(640 - 90);
  }
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.gallery-thumb').first().click();
  await expect(controls).toBeVisible();
});

test('restores message positions for date jumps and gallery filters after preview jumps', async ({ page }) => {
  await openChat(page, 120);
  const before = await page.locator('#chat').evaluate(element => element.scrollTop);
  await expect(page.locator('.chat-header .date-nav-controls')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await page.locator('.mobile-date-section summary').click();
  const historyLength = await page.evaluate(() => history.length);
  const next = page.getByRole('button', { name: 'Next period', exact: true });
  await (await next.isEnabled() ? next : page.getByRole('button', { name: 'Previous period', exact: true })).click();
  await expectScreen(page, 'info');
  for (const scale of ['Week', 'Day']) {
    await page.getByRole('button', { name: scale, exact: true }).click();
    await page.locator('.mobile-date-section input[type="range"]').focus();
    await page.locator('.mobile-date-section input[type="range"]').press('End');
    await expectScreen(page, 'info');
  }
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.locator('.mobile-date-section .date-nav-item').first().click();
  await expectScreen(page, 'chat');
  await expect(page.locator('.message.highlight-target')).toBeVisible();
  await page.evaluate(() => history.back());
  await expectScreen(page, 'info');
  await expect.poll(() => page.locator('#chat').evaluate(element => element.scrollTop)).toBeGreaterThan(before - 20);
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle attachment filters' }).click();
  await page.getByLabel('Search links or filenames. Type plus, minus, or dot to open sender suggestions.').fill('photo');
  await page.getByLabel('Search links or filenames. Type plus, minus, or dot to open sender suggestions.').press('Enter');
  await page.locator('.gallery-thumb').first().click();
  await viewerAction(page, 'Jump to message');
  await page.evaluate(() => history.back());
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('Search links or filenames. Type plus, minus, or dot to open sender suggestions.')).toHaveValue('photo');
});

test('keeps the actual repeated attachment shown by viewer swipes', async ({ page }) => {
  await openChat(page, 25);
  await openGallery(page);
  await page.locator('.gallery-thumb').first().click();
  await swipeViewer(page, 'left');
  const date = await page.locator('.media-viewer-date').textContent();
  await viewerAction(page, 'Jump to message');
  await page.evaluate(() => history.back());
  await expect(page.locator('.media-viewer-date')).toHaveText(date!);
});

test('preserves desktop panel preferences through the mobile breakpoint and landscape', async ({ page }) => {
  await openChat(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Toggle chat info panel', exact: true }).click();
  const settings = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /setting_(sidebarWidth|infoPanelWidth|infoPanelOpen)$/.test(key))));
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.locator('#sidebar')).toBeHidden();
  await expectScreen(page, 'info');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 320 });
  await expectScreen(page, 'info');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('.sidebar-resize-handle')).toBeVisible();
  await expect(page.locator('#chatInfoPanel')).toBeVisible();
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /setting_(sidebarWidth|infoPanelWidth|infoPanelOpen)$/.test(key))))).toEqual(settings);
  await page.setViewportSize({ width: 769, height: 800 });
  await expect(page.locator('#sidebar')).toBeVisible();
});

test('starts at Home after refresh and ignores destinations from the previous archive session', async ({ page }) => {
  await openChat(page);
  await openGallery(page);
  await page.reload();
  await expectScreen(page, 'home');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'home');
});

test('restores gallery scroll and the preview occurrence through the return action', async ({ page }) => {
  await openChat(page, 160);
  await openGallery(page);
  await page.locator('.gallery-scroll').evaluate(element => { element.scrollTop = 900; });
  const top = await page.locator('.gallery-scroll').evaluate(element => element.scrollTop);
  const visibleCard = await page.locator('.gallery-thumb').evaluateAll(cards => {
    const viewport = document.querySelector('.gallery-scroll')!.getBoundingClientRect();
    return cards.findIndex(card => { const rect = card.getBoundingClientRect(); return rect.top >= viewport.top && rect.bottom <= viewport.bottom; });
  });
  expect(visibleCard).toBeGreaterThanOrEqual(0);
  await page.locator('.gallery-thumb').nth(visibleCard).click();
  const viewer = page.locator('.media-viewer-overlay');
  const date = (await viewer.locator('.media-viewer-date').textContent())!;
  await viewerAction(page, 'Jump to message');
  await expectScreen(page, 'chat');
  await page.getByRole('button', { name: 'Return to attachment', exact: true }).click();
  await expectScreen(page, 'gallery');
  await expect(viewer.locator('.media-viewer-date')).toHaveText(date);
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.media-viewer-overlay')).toHaveCount(0);
  await expect.poll(() => page.locator('.gallery-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(top - 20);
  await page.screenshot({ path: test.info().outputPath('gallery.png') });
});

test('fits three or four media columns on mobile and preserves the desktop grid', async ({ page }) => {
  await openChat(page, 120);
  await openGallery(page);
  await page.locator('.gallery-tab').filter({ hasText: 'Photos' }).click();

  for (const [width, height, columns] of [[320, 844, 3], [390, 844, 4], [640, 320, 4], [768, 844, 4]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.locator('.gallery-grid').first().evaluate(element => (
      getComputedStyle(element).gridTemplateColumns.split(' ').length
    ))).toBe(columns);
    const geometry = await page.locator(`.gallery-grid:has(> .gallery-thumb:nth-child(${columns}))`).first().evaluate(element => {
      const row = element.getBoundingClientRect();
      return {
        left: row.left,
        right: row.right,
        cards: Array.from(element.children, card => {
          const rect = card.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height, top: rect.top };
        }),
      };
    });
    expect(geometry.cards).toHaveLength(columns);
    for (const card of geometry.cards) {
      expect(card.width).toBeGreaterThanOrEqual(80);
      expect(card.width).toBeCloseTo(card.height, 0);
      expect(card.top).toBeCloseTo(geometry.cards[0].top, 0);
      expect(card.left).toBeGreaterThanOrEqual(geometry.left);
      expect(card.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (height > 320) {
      const thumbnail = page.locator('.gallery-thumb').first();
      await thumbnail.scrollIntoViewIfNeeded();
      expect(await thumbnail.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest('.gallery-link-message, .gallery-open-viewer-btn') === null;
      })).toBe(true);
    }
  }

  await page.locator('.gallery-thumb').first().tap();
  await expect(page.locator('.media-viewer-overlay')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expectScreen(page, 'gallery');
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect.poll(() => page.locator('.gallery-grid').first().evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  ))).toBeGreaterThan(4);
});

test('opens mobile images at their fitted size without a viewport flash', async ({ page }) => {
  await openChat(page, 0, true);
  await openGallery(page);
  for (const [width, height] of [[390, 844], [320, 640], [640, 320]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      const capture = { frames: [] as { width: number; height: number }[], done: false };
      (window as unknown as { viewerSizingCapture: typeof capture }).viewerSizingCapture = capture;
      const sample = () => {
        const image = document.querySelector<HTMLImageElement>('.media-viewer-image');
        if (image?.naturalWidth && getComputedStyle(image).visibility !== 'hidden') {
          const bounds = image.getBoundingClientRect();
          capture.frames.push({ width: bounds.width, height: bounds.height });
        }
        if (capture.frames.length >= 20) capture.done = true;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator('.gallery-thumb[title="photo.jpg"]').first().click();
    await expect(page.locator('.media-viewer-image')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { viewerSizingCapture: { done: boolean } }).viewerSizingCapture.done
    ))).toBe(true);
    const frames = await page.evaluate(() => (
      (window as unknown as { viewerSizingCapture: { frames: { width: number; height: number }[] } }).viewerSizingCapture.frames
    ));
    const fittedWidth = Math.min(120, width, (height - 100) / 3);
    for (const frame of frames) {
      expect(frame.width).toBeLessThanOrEqual(fittedWidth + 1);
      expect(frame.height).toBeLessThanOrEqual(fittedWidth * 3 + 1);
    }
    expect(frames.at(-1)!.width).toBeCloseTo(fittedWidth, 0);
    await page.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(page.locator('.media-viewer-overlay')).toHaveCount(0);
    await expectScreen(page, 'gallery');
  }
});

test('keeps mobile viewer controls beside metadata and toggles the largest image view', async ({ page }) => {
  await openChat(page, 20, true);
  await openGallery(page);
  await page.getByTitle('Select attachments and links', { exact: true }).click();
  const card = page.locator('.gallery-thumb[title="photo.jpg"]').first();
  await card.click();
  await page.getByRole('button', { name: 'Review selection', exact: true }).click();
  await page.locator('.selection-panel .gallery-thumb').first().click();
  const viewer = page.locator('.media-viewer-overlay');
  const image = viewer.locator('.media-viewer-image');
  const topbar = viewer.locator('.media-viewer-topbar');
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);
  const historyLength = await page.evaluate(() => history.length);

  await page.getByRole('button', { name: 'Deselect item', exact: true }).locator('svg').tap();
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await page.getByRole('button', { name: 'Select item', exact: true }).tap();
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await page.getByRole('button', { name: 'Bookmark item', exact: true }).locator('svg').tap();
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await page.getByRole('button', { name: 'More options', exact: true }).locator('svg').tap();
  await expect(viewer.locator('.media-viewer-menu-dropdown')).toBeVisible();
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await page.getByRole('button', { name: 'More options', exact: true }).tap();
  await swipeViewer(page, 'left');
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await swipeViewer(page, 'right');
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const header = await topbar.evaluate(element => {
      const rect = (selector: string) => {
        const bounds = element.querySelector(selector)!.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
      };
      return { meta: rect('.media-viewer-meta'), actions: rect('.media-viewer-actions'), counter: rect('.media-viewer-counter') };
    });
    expect(header.actions.left).toBeGreaterThanOrEqual(header.meta.right);
    expect(header.actions.top).toBeLessThan(header.meta.bottom);
    expect(header.actions.bottom).toBeGreaterThan(header.meta.top);
    expect(header.counter.top).toBeGreaterThanOrEqual(Math.max(header.meta.bottom, header.actions.bottom));
    expect(header.counter.left).toBeCloseTo(header.meta.left, 0);
    expect(header.actions.right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect.poll(async () => Math.round((await image.boundingBox())!.height)).toBe(360);
    const original = await image.boundingBox();

    await image.tap();
    await expect(image).toHaveAttribute('aria-pressed', 'true');
    await expect(topbar).toHaveCSS('opacity', '0');
    await expect(topbar).toHaveAttribute('inert', '');
    await expect(viewer).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.round((await image.boundingBox())!.height)).toBe(844);
    expect((await image.boundingBox())!.width).toBeCloseTo(844 / 3, 0);

    await image.tap();
    await expect(image).toHaveAttribute('aria-pressed', 'false');
    await expect(topbar).toHaveCSS('opacity', '1');
    await expect.poll(async () => Math.round((await image.boundingBox())!.height)).toBe(Math.round(original!.height));
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  }

  await image.focus();
  await image.press('Enter');
  await expect(image).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 640, height: 320 });
  await expect.poll(async () => Math.round((await image.boundingBox())!.height)).toBe(320);
  await image.press('Escape');
  await expect(image).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Deselect item', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await image.tap();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(topbar).toHaveCSS('display', 'flex');
  await expect(topbar).toHaveCSS('opacity', '1');
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await image.click();
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(image).toHaveAttribute('aria-pressed', 'false');

  await image.tap();
  await page.keyboard.press('Escape');
  await expect(viewer).not.toHaveClass(/image-expanded/);
  await expect(topbar).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.evaluate(() => history.back());
  await expect(viewer).toHaveCount(0);
  await expectScreen(page, 'selected');
});

test('swipes across the mobile viewer without sticky button hover or accidental image taps', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page, 20, true);
  await openGallery(page);
  await page.locator('.gallery-tab').filter({ hasText: 'Photos' }).click();
  await page.locator('.gallery-thumb').first().click();
  const viewer = page.locator('.media-viewer-overlay');
  const image = viewer.locator('.media-viewer-image');
  const date = viewer.locator('.media-viewer-date');
  const menu = viewer.getByRole('button', { name: 'More options', exact: true });
  await expect(image).toBeVisible();
  await expect(viewer.locator('.media-viewer-nav')).toHaveCount(0);
  await menu.tap();
  await expect(menu).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.1)');
  await menu.tap();
  await expect(menu).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.1)');
  await expect(image).toHaveAttribute('aria-pressed', 'false');
  const historyLength = await page.evaluate(() => history.length);
  const newestDate = (await date.textContent())!;

  await swipeViewer(page, 'left');
  await expect(date).not.toHaveText(newestDate);
  const olderDate = (await date.textContent())!;
  await expect(image).toHaveAttribute('aria-pressed', 'false');
  await swipeViewer(page, 'right', '.media-viewer-date', 0.5);
  await expect(date).toHaveText(newestDate);

  await image.tap();
  await expect(image).toHaveAttribute('aria-pressed', 'true');
  await swipeViewer(page, 'left', '.media-viewer-image', 0.5);
  await expect(date).toHaveText(olderDate);
  await expect(image).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.media-viewer-topbar')).toHaveCSS('opacity', '0');
  await swipeViewer(page, 'right');
  await expect(date).toHaveText(newestDate);
  await expect(image).toHaveAttribute('aria-pressed', 'true');
  await image.tap();
  await expect(image).toHaveAttribute('aria-pressed', 'false');

  await swipeViewer(page, 'left');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await viewerAction(page, 'Jump to message');
  await expectScreen(page, 'chat');
  await page.evaluate(() => history.back());
  await expect(viewer).toBeVisible();
  await expect(date).toHaveText(olderDate);
  await page.getByRole('button', { name: 'Close', exact: true }).tap();
  await expect(viewer).toHaveCount(0);
  await expectScreen(page, 'gallery');

  await page.setViewportSize({ width: 1280, height: 844 });
  await page.locator('.gallery-thumb').first().click();
  await expect(viewer.locator('.media-viewer-nav')).not.toHaveCount(0);
  await menu.hover();
  await expect(menu).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.2)');
  await page.getByRole('button', { name: 'Older item', exact: true }).click();
  await expect(date).toHaveText(olderDate);
});

test('returns across search jumps between chats', async ({ page }) => {
  await openChat(page);
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('needle');
  await search.press('Enter');
  await page.getByRole('option').filter({ hasText: 'needle from Facebook' }).click();
  await expectScreen(page, 'chat');
  await expect(page.locator('.message.highlight-target')).toContainText('needle from Facebook');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'home');
  await expect(search).toHaveValue('needle');
  await page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' }).click();
  await expect(page.locator('#chat')).toContainText('keep this chat');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'home');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'chat');
  await expect(page.locator('#chat')).toContainText('needle from Facebook');
});

test('keeps desktop gallery open when switching sidebar tabs and adds no desktop history', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installArchive(page, 'facebook');
  await page.goto('');
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat .message')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle chat info panel', exact: true }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attachments', exact: true })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test('ignores a superseded chat load after browser Back', async ({ page }) => {
  await openChat(page);
  await page.getByRole('button', { name: 'Back to chat list', exact: true }).click();
  await page.evaluate(async () => {
    const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle }; releaseBob?: () => void; bobStarted?: boolean; bobFinished?: boolean };
    const inbox = await fixture.__testArchives.facebook.getDirectoryHandle('inbox');
    const bob = await inbox.getDirectoryHandle('bob_chat');
    const file = await bob.getFileHandle('message_1.json');
    const getFile = file.getFile.bind(file);
    Object.defineProperty(file, 'getFile', { value: async () => {
      fixture.bobStarted = true;
      await new Promise<void>(resolve => { fixture.releaseBob = resolve; });
      const result = await getFile();
      fixture.bobFinished = true;
      return result;
    } });
  });
  await page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { bobStarted?: boolean }).bobStarted)).toBe(true);
  const loading = await page.locator('.load-progress-block').boundingBox();
  expect(loading!.width).toBeLessThanOrEqual(280);
  expect(loading!.x).toBeGreaterThanOrEqual(24);
  await page.evaluate(() => history.back());
  await expectScreen(page, 'home');
  await page.evaluate(() => (window as unknown as { releaseBob: () => void }).releaseBob());
  await expect.poll(() => page.evaluate(() => (window as unknown as { bobFinished?: boolean }).bobFinished)).toBe(true);
  await expect(page.locator('.chat-container h3')).toHaveText('Alice Chat');
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expectScreen(page, 'chat');
  await expect(page.locator('#chat')).toContainText('needle from Facebook');
});

for (const ratio of [1.25, 2.625, 3]) {
  test.describe(`message date paint at ${ratio} device pixels per CSS pixel`, () => {
    test.use({ deviceScaleFactor: ratio });

    test('preserves painted bubble and reaction heights and gaps when dates open and close', async ({ page }) => {
      await installArchive(page, 'facebook');
      await page.goto('');
      await page.evaluate(async () => {
        const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
        const inbox = await fixture.__testArchives.facebook.getDirectoryHandle('inbox');
        const chat = await inbox.getDirectoryHandle('alice_chat');
        const file = await chat.getFileHandle('message_1.json');
        const data = JSON.parse(await (await file.getFile()).text());
        const messages = [...Array.from({ length: 24 }, (_, index) => `Earlier message ${index}`), 'Message with a reaction', 'Short reply', 'Yes', 'Okay'];
        data.messages = messages.map((content, index) => ({
          sender_name: 'Tester', timestamp_ms: 1761836520000 + index * 1000, content,
          ...(index === 24 ? { reactions: [
            { reaction: '\u{1f60d}', actor: 'Alice' },
            { reaction: '\u{1f602}', actor: 'Bob' },
            { reaction: '\u2764\ufe0f', actor: 'Charlie' },
          ] } : index === 25 ? { reactions: [{ reaction: '\u{1f44d}', actor: 'Alice' }] } : {}),
        }));
        const writer = await file.createWritable();
        await writer.write(JSON.stringify(data));
        await writer.close();
      });
      await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
      await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
      await page.locator('#chat[aria-busy="false"]:not([data-opening="true"])').waitFor();
      const first = page.locator('.message').filter({ hasText: 'Message with a reaction' });
      const lower = page.locator('.message').filter({ hasText: 'Short reply' });
      await first.scrollIntoViewIfNeeded();
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
      });
      for (const [message, count] of [[first, 4], [lower, 3]] as const) {
        const boxes = await page.locator('#chat').evaluate((chat, count) => [...chat.querySelectorAll<HTMLElement>('.message')].slice(-count).map(element => {
          const box = element.getBoundingClientRect();
          const color = getComputedStyle(element).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number);
          return { x: box.x, y: box.y, width: box.width, height: box.height, color };
        }), count);
        const before = await captureBubblePaint(page, boxes);
        const reactions = await page.locator('#chat').evaluate((chat, count) => [...chat.querySelectorAll<HTMLElement>('.message')].slice(-count)
          .flatMap(message => [...message.querySelectorAll<HTMLElement>('.reaction-bubble')].map(element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              x: box.x, y: box.y, width: box.width, height: box.height,
              color: style.borderTopColor.match(/\d+/g)!.slice(0, 3).map(Number),
              paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
              contents: [...element.querySelectorAll('.reaction-emoji-simple, .reaction-count')].map(content => {
                const rect = content.getBoundingClientRect();
                return { height: rect.height, centerOffset: rect.y + rect.height / 2 - box.y - box.height / 2 };
              }),
            };
          })), count);
        for (const reaction of reactions) {
          expect(reaction.height).toBe(24);
          expect(reaction.paddingTop).toBe(reaction.paddingBottom);
          for (const content of reaction.contents) {
            expect(content.height).toBe(18);
            expect(Math.abs(content.centerOffset)).toBeLessThanOrEqual(0.02);
          }
        }
        const reactionPaintBefore = await captureBubblePaint(page, reactions);
        await tapWithoutMovingFollowingMessages(page, message);
        await expect(page.locator('.reaction-modal-overlay')).toHaveCount(0);
        expect(await captureBubblePaint(page, boxes), 'Opening a date must preserve painted heights and gaps').toEqual(before);
        expect(await captureBubblePaint(page, reactions), 'Opening a date must preserve the reaction outlines').toEqual(reactionPaintBefore);
        await tapWithoutMovingFollowingMessages(page, message);
        expect(await captureBubblePaint(page, boxes), 'Closing a date must preserve painted heights and gaps').toEqual(before);
        expect(await captureBubblePaint(page, reactions), 'Closing a date must preserve the reaction outlines').toEqual(reactionPaintBefore);
      }
      await first.locator('.reaction-bubble').tap();
      await expect(page.locator('.reaction-modal-overlay')).toBeVisible();
      expect(await page.locator('.reaction-modal-overlay').boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! });
      await page.locator('.modal-actor').first().tap();
      await expect(first).not.toHaveAttribute('data-timestamp-visible', 'true');
      await page.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(page.locator('.reaction-modal-overlay')).toHaveCount(0);
    });
  });
}

test('preserves bubbles, text, and separators when older message groups unload during date taps', async ({ page }) => {
  test.setTimeout(90_000);
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.evaluate(async () => {
    const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
    const chat = await (await fixture.__testArchives.facebook.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat');
    const file = await chat.getFileHandle('message_1.json');
    const data = JSON.parse(await (await file.getFile()).text());
    const texts = [
      'miming all saints day', 'wut', 'ah', 'ata', 'im not built for frontend bru HAHAHAHH',
      "tanggappin pa kaya ng ma'am", 'bat kasi ang sudden, di naman ata nag sabi before na mag aral na mag ui/ux e T.T',
      'tinitingnan siguro ni maam kung sino built for design', 'real', 'ganyan talaga yan', 'masanay na tayo', 'more to come',
      'Wrapped text with mixed letters: minimum, winding, quick, jumping, and measuring bubble heights.',
      'First line\nSecond line\nThird line',
    ];
    data.messages = Array.from({ length: 100 }, (_, index) => ({
      sender_name: index % 10 < 5 ? 'Alice' : 'Tester',
      timestamp_ms: 1761836520000 + Math.floor(index / 4) * 3600000 + index * 1000,
      content: `${index}: ${texts[index % texts.length]}`,
      ...(index % 7 === 0 ? { reactions: [{ reaction: '\u{1f60d}', actor: index % 10 < 5 ? 'Tester' : 'Alice' }] } : {}),
    }));
    const writer = await file.createWritable();
    await writer.write(JSON.stringify(data));
    await writer.close();
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await page.locator('#chat[aria-busy="false"]:not([data-opening="true"])').waitFor();
  const older = page.locator('.message-chunk[data-chunk-index="0"]');
  let unloadedDuringTap = false;
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const index of [72, 73, 84]) {
      const message = page.locator(`.message[data-msg-index="${index}"]`);
      await message.scrollIntoViewIfNeeded();
      await page.locator('#chat').evaluate((chat, index) => {
        const message = chat.querySelector(`.message[data-msg-index="${index}"]`)!;
        chat.scrollTop += message.getBoundingClientRect().top - chat.getBoundingClientRect().top - 120;
      }, index);
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
      });
      const before = await older.evaluate(element => ({ rendered: element.getAttribute('data-rendered'), height: element.getBoundingClientRect().height }));
      const paintBoxes = await page.locator('#chat').evaluate((chat, index) => {
        const tapped = chat.querySelector(`.message[data-msg-index="${index}"]`)!;
        const viewport = chat.getBoundingClientRect();
        return [...chat.querySelectorAll('.message, .time-separator:not(.mobile-msg-timestamp)')]
          .filter(element => tapped === element || !!(tapped.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
          .map(element => element.getBoundingClientRect())
          .filter(rect => rect.top > viewport.top && rect.bottom < viewport.bottom)
          .map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
      }, index);
      const paint = await captureRegionPaint(page, paintBoxes);
      await tapWithoutMovingFollowingMessages(page, message);
      const after = await older.evaluate(element => ({ rendered: element.getAttribute('data-rendered'), height: element.getBoundingClientRect().height }));
      if (before.rendered === 'true' && after.rendered === 'false') unloadedDuringTap = true;
      expect(Math.abs(after.height - before.height), 'Unloading must retain the full fractional group height').toBeLessThanOrEqual(0.02);
      expect(await captureRegionPaint(page, paintBoxes), 'Complete bubble and separator pixels must stay unchanged when a date opens').toEqual(paint);
      await tapWithoutMovingFollowingMessages(page, message);
      expect(await captureRegionPaint(page, paintBoxes), 'Complete bubble and separator pixels must stay unchanged when a date closes').toEqual(paint);
    }
  }
  expect(unloadedDuringTap, 'Exercise unloading an older group during a date tap').toBe(true);
});

test('keeps tapped bubbles stationary in short mobile chats without initial scrolling', async ({ page }) => {
  await openChat(page);
  const message = page.locator('.message').filter({ hasText: 'needle from Facebook' });
  const date = message.locator('..').locator('.mobile-msg-timestamp');
  const bubbleDimensions = () => page.locator('#chat').evaluate(chat => ({
    width: chat.clientWidth,
    bubbles: [...chat.querySelectorAll<HTMLElement>('.message')].map(message => {
      const { width, height } = message.getBoundingClientRect();
      return { index: message.dataset.msgIndex, width, height };
    }),
  }));
  const before = await message.boundingBox();
  const dimensionsBefore = await bubbleDimensions();
  await tapWithoutMovingFollowingMessages(page, message);
  await expect(date).toBeVisible();
  expect(Math.abs((await message.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(await bubbleDimensions()).toEqual(dimensionsBefore);
  await tapWithoutMovingFollowingMessages(page, message);
  await expect(date).toBeHidden();
  expect(Math.abs((await message.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(await bubbleDimensions()).toEqual(dimensionsBefore);
});

test('keeps following bubbles and text stable for wrapped dates, lower messages, and mobile resizing', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page, 40);
  await page.addStyleTag({ content: '@media (max-width: 768px) { .mobile-msg-timestamp { width: 35%; } }' });
  const upper = page.locator('.message').filter({ hasText: 'History message 18 with enough text' });
  const lower = page.locator('.message').filter({ hasText: 'History message 19 with enough text' });
  const date = lower.locator('..').locator('.mobile-msg-timestamp');
  for (const [width, height] of [[320, 844], [390, 844], [640, 320]]) {
    await page.setViewportSize({ width, height });
    if (await lower.getAttribute('data-timestamp-visible')) {
      await expect.poll(() => date.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const style = getComputedStyle(element);
        const natural = Math.ceil(range.getClientRects().length * parseFloat(style.lineHeight));
        const height = element.getBoundingClientRect().height;
        if (height < natural || height >= natural + 16) return Infinity;
        const outer = height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        return Math.max(Math.abs(outer - Math.round(outer)), Math.abs(outer * devicePixelRatio - Math.round(outer * devicePixelRatio)));
      })).toBeLessThanOrEqual(0.02);
      await tapWithoutMovingFollowingMessages(page, lower);
    }
    await tapWithoutMovingFollowingMessages(page, upper);
    await tapWithoutMovingFollowingMessages(page, lower);
    await expect(upper).not.toHaveAttribute('data-timestamp-visible', 'true');
    await expect(date).toBeVisible();
    if (height > 320) {
      expect(await date.evaluate(element => element.getBoundingClientRect().height
        > parseFloat(getComputedStyle(element).lineHeight) * 1.5)).toBe(true);
    }
    await tapWithoutMovingFollowingMessages(page, lower);
    await tapWithoutMovingFollowingMessages(page, lower);
  }
  await tapWithoutMovingFollowingMessages(page, lower);
  const last = page.locator('.message').filter({ hasText: 'History message 39 with enough text' });
  await tapWithoutMovingFollowingMessages(page, last);
  await tapWithoutMovingFollowingMessages(page, last);
});

test('reveals mobile dates above tapped messages without moving the tapped bubble', async ({ page }) => {
  await openChat(page, 20);
  const message = page.locator('.message').filter({ hasText: 'History message 19 with enough text' });
  const previous = page.locator('.message').filter({ hasText: 'History message 18 with enough text' });
  const timestamp = message.locator('.msg-timestamp');
  const dateRow = message.locator('..').locator('.mobile-msg-timestamp');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await message.scrollIntoViewIfNeeded();
    const before = await message.boundingBox();
    const preceding = await previous.boundingBox();
    await message.locator('.message-text').tap();
    await expect(message).toHaveAttribute('data-timestamp-visible', 'true');
    await expect(dateRow).toBeVisible();
    await expect(dateRow).toHaveAttribute('aria-hidden', 'false');
    const geometry = await message.evaluate(element => {
      const bubble = element.getBoundingClientRect();
      const wrapper = element.closest('.message-wrapper')!;
      const row = wrapper.getBoundingClientRect();
      const date = wrapper.querySelector<HTMLElement>('.mobile-msg-timestamp')!;
      const rect = date.getBoundingClientRect();
      return { bubble: bubble.width, top: bubble.top, row: row.width, left: rect.left, right: rect.right,
        bottom: rect.bottom, rowLeft: row.left, rowRight: row.right, wrapping: getComputedStyle(date).whiteSpace };
    });
    expect(geometry.bubble).toBeCloseTo(geometry.row * 0.7, 0);
    expect(Math.abs(geometry.top - before!.y)).toBeLessThanOrEqual(1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.top);
    expect(geometry.wrapping).toBe('normal');
    expect(geometry.left).toBeCloseTo(geometry.rowLeft, 0);
    expect(geometry.right).toBeCloseTo(geometry.rowRight, 0);
    await expect(dateRow).toHaveCSS('text-align', 'center');
    expect((await previous.boundingBox())!.y).toBeLessThan(preceding!.y - 20);

    await message.locator('.message-text').tap();
    await expect(dateRow).toBeHidden();
    expect(Math.abs((await message.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(1);

    await message.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 50, clientY: 300 });
    await page.waitForTimeout(600);
    await message.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 50, clientY: 300 });
    await expect(dateRow).toBeHidden();

    await message.locator('.message-text').tap();
    const otherBefore = await previous.boundingBox();
    await previous.locator('.message-text').tap();
    await expect(message).not.toHaveAttribute('data-timestamp-visible', 'true');
    await expect(previous).toHaveAttribute('data-timestamp-visible', 'true');
    expect(Math.abs((await previous.boundingBox())!.y - otherBefore!.y)).toBeLessThanOrEqual(1);
    await page.locator('#chat').evaluate(element => { element.scrollTop -= 60; });
    await expect(previous).toHaveAttribute('data-timestamp-visible', 'true');
    await previous.locator('.message-text').tap();
    await expect(previous).not.toHaveAttribute('data-timestamp-visible', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(message).toHaveCSS('max-width', '50%');
  await expect(dateRow).toBeHidden();
  await expect(timestamp).toHaveCSS('white-space', 'nowrap');
  await message.hover();
  await expect(timestamp).toHaveCSS('opacity', '1');
});
