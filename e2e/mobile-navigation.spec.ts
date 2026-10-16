import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installArchive } from './helpers/archive';

// These workflows traverse multiple screens; Windows WebKit is slower than Chromium.
test.setTimeout(60_000);

async function openChat(page: Page, longMessages = 0, withValidImage = false, unavailableMedia = false, withViewerMedia = false, beforeSelect?: (page: Page) => Promise<void>) {
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
  if (withViewerMedia) {
    const video = [...readFileSync(new URL('./fixtures/portrait.mp4', import.meta.url))];
    const audio = [...readFileSync(new URL('./fixtures/silence.wav', import.meta.url))];
    await page.evaluate(async ({ video, audio }) => {
      const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
      const inbox = await fixture.__testArchives.facebook.getDirectoryHandle('inbox');
      const alice = await inbox.getDirectoryHandle('alice_chat');
      for (const [directory, name, bytes] of [['videos', 'portrait.mp4', video], ['audio', 'silence.wav', audio], ['files', 'sample.txt', [65, 66, 67]]] as const) {
        const folder = await alice.getDirectoryHandle(directory, { create: true });
        const file = await folder.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write(new Uint8Array(bytes));
        await writer.close();
      }
      const file = await alice.getFileHandle('message_1.json');
      const data = JSON.parse(await (await file.getFile()).text());
      data.messages.push(
        { sender_name: 'Alice', timestamp_ms: 25, videos: [{ uri: 'videos/portrait.mp4' }] },
        { sender_name: 'Alice', timestamp_ms: 26, audio_files: [{ uri: 'audio/silence.wav' }] },
        { sender_name: 'Alice', timestamp_ms: 27, files: [{ uri: 'files/sample.txt' }] },
      );
      const writer = await file.createWritable();
      await writer.write(JSON.stringify(data));
      await writer.close();
    }, { video, audio });
  }
  await beforeSelect?.(page);
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await expect(page.locator('#chat .message')).not.toHaveCount(0);
  await expectScreen(page, 'chat');
}

async function setMessengerPhoto(page: Page) {
  await page.evaluate(async () => {
    const fixture = window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } };
    const photo = await (await fixture.__testArchives.messenger.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 24;
    canvas.getContext('2d')!.fillRect(0, 0, 12, 24);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const writer = await photo.createWritable();
    await writer.write(new Uint8Array(await png.arrayBuffer()));
    await writer.close();
  });
}

async function expectScreen(page: Page, screen: string) {
  await expect(page.locator('.container')).toHaveAttribute('data-mobile-screen', screen);
}

async function selectFolderAccess(page: Page, mode: 'native' | 'upload') {
  const trigger = page.getByRole('button', { name: 'Folder access', exact: true });
  const label = mode === 'native' ? 'Native access' : 'Read-only access';
  await trigger.click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(trigger).toContainText(label);
}

async function enableDebuggingOnLoad(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(`majv_${location.hostname}_setting_debuggingEnabled`, '1');
  });
}

async function expectLoadingAnimation(status: Locator, showSpinner = true) {
  const spinner = status.locator('.loading-spinner');
  if (showSpinner) {
    await expect(spinner).toHaveCSS('animation-name', 'loading-spin');
    const initialTransform = await spinner.evaluate(element => getComputedStyle(element).transform);
    await expect.poll(() => spinner.evaluate(element => getComputedStyle(element).transform)).not.toBe(initialTransform);
  } else await expect(spinner).toHaveCount(0);
  const dots = status.locator('.loading-dots');
  const initialClip = await dots.evaluate(element => getComputedStyle(element).clipPath);
  await expect.poll(() => dots.evaluate(element => getComputedStyle(element).clipPath), { intervals: [80] }).not.toBe(initialClip);
  await expect.poll(() => dots.evaluate(element => getComputedStyle(element).clipPath), { intervals: [80] }).toBe(initialClip);
}

async function useNearbyMessageTimes(page: Page) {
  await page.evaluate(async () => {
    const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
    const chat = await (await fixture.__testArchives.facebook.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat');
    const file = await chat.getFileHandle('message_1.json');
    const data = JSON.parse(await (await file.getFile()).text());
    for (const message of data.messages) {
      const index = /^History message (\d+) /.exec(message.content ?? '')?.[1];
      if (index !== undefined) message.timestamp_ms = 1700000000000 + Number(index) * 60_000;
    }
    const writer = await file.createWritable();
    await writer.write(JSON.stringify(data));
    await writer.close();
  });
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
    const capture = { before: measure(), frames: [] as ReturnType<typeof measure>[], done: false, start: () => {} };
    (window as unknown as { timestampStability: typeof capture }).timestampStability = capture;
    const sample = () => {
      capture.frames.push(measure());
      if (capture.frames.length >= 8) capture.done = true;
      else requestAnimationFrame(sample);
    };
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      observer.disconnect();
      sample();
    };
    const observer = new MutationObserver(start);
    capture.start = start;
    observer.observe(chat, { subtree: true, attributes: true, attributeFilter: ['data-timestamp-visible'] });
  }, index);
  await message.locator('.message-text').tap();
  // A message with its own separator deliberately makes no timestamp mutation.
  await page.evaluate(() => (window as unknown as { timestampStability: { start: () => void } }).timestampStability.start());
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
  const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
  await viewer.getByRole('button', { name: 'More options', exact: true }).click();
  await viewer.getByRole('button', { name: action, exact: true }).click();
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

test('keeps folder and chat-sort dropdowns usable at narrow mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await installArchive(page, 'facebook');
  await page.goto('');
  const folderAccess = page.getByRole('button', { name: 'Folder access', exact: true });
  await folderAccess.click();
  const accessList = page.getByRole('listbox', { name: 'Folder access', exact: true });
  await expect(accessList).toBeVisible();
  for (const option of await accessList.getByRole('option').all()) {
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');
  await expect(folderAccess).toBeFocused();
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chats = page.locator('.chat-list-item');
  await expect(chats.first()).toContainText('Alice Chat');
  const sort = page.getByRole('button', { name: 'Sort chats', exact: true });
  await sort.click();
  const list = page.getByRole('listbox', { name: 'Sort chats', exact: true });
  const bounds = (await list.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath('chat-sort-mobile.png') });
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Oldest', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sort).toContainText('Oldest');
  await expect(sort).toBeFocused();
  await expect(list).toHaveCount(0);
  await expect(chats.first()).toContainText('Bob Chat');
  await sort.click();
  await page.getByRole('option', { name: 'Recent', exact: true }).tap();
  await expect(chats.first()).toContainText('Alice Chat');
  await sort.click();
  await page.keyboard.press('Tab');
  await expect(list).toHaveCount(0);
  await expect(sort).not.toBeFocused();
});

test('shows animated feedback while checking archive and clears it on cancel', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.addInitScript(() => {
    localStorage.setItem(`majv_${location.hostname}_setting_reactionTimestampGuessingMode`, 'off');
    const Original = window.Worker;
    window.Worker = class extends Original {
      private audit: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.audit = String(url).includes('reactionAuditWorker');
      }
      postMessage(input: { type?: string }) {
        if (this.audit && input.type === 'thread') return;
        super.postMessage(input);
      }
    };
  });
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check archive', exact: true }).click();
  const indicator = page.locator('.archive-check-label .loading-spinner');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveCSS('animation-name', 'loading-spin');
  await expect(page.getByRole('status').filter({ hasText: 'Full archive consistency check running.' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(indicator).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Check canceled.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
});

for (const accessMode of ['native', 'upload'] as const) {
  test(`shows immediate chat-loading feedback with ${accessMode} access`, async ({ page }) => {
    await installArchive(page, 'facebook', false, false, false, 0, true);
    await page.goto('');
    if (accessMode === 'upload') await selectFolderAccess(page, accessMode);
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
    await expect(alice).toBeVisible();
    const preview = await alice.locator('.chat-item-preview').textContent();
    await page.evaluate(() => {
      const fixture = window as unknown as { chatParsingStarted?: boolean; releaseChatParsing?: () => void };
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        private readonly chatParser: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.chatParser = String(url).includes('parserWorker');
        }
        postMessage(message: unknown, transfer: Transferable[] = []) {
          if (this.chatParser) {
            fixture.chatParsingStarted = true;
            fixture.releaseChatParsing = () => super.postMessage(message, transfer);
          } else super.postMessage(message, transfer);
        }
      };
    });
    await alice.click();
    await expectScreen(page, 'chat');
    const progress = page.getByRole('progressbar', { name: 'Chat loading progress' });
    await expect(progress).toBeVisible();
    await expect(page.locator('.load-progress-label')).toContainText(/Loading messages|Scanning files|Preparing files|Processing data/);
    await expectLoadingAnimation(page.locator('.load-progress-label'));
    await expect.poll(() => page.evaluate(() => (window as unknown as { chatParsingStarted?: boolean }).chatParsingStarted)).toBe(true);
    await expect(page.locator('.chat-header h3')).toHaveText('Alice Chat');
    await page.screenshot({ path: test.info().outputPath(`chat-loading-${accessMode}-mobile.png`) });

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(alice).toBeVisible();
    await expect(alice).toHaveAttribute('aria-busy', 'true');
    await expect(alice.locator('.chat-item-preview')).toHaveText(preview!);
    await expect(alice).not.toContainText('Loading chat');
    await expect(alice.locator('.loading-spinner')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { releaseChatParsing: () => void }).releaseChatParsing());
    await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#chat')).toContainText('needle from Facebook');
    await expect(progress).toHaveCount(0);
    await expect(alice).not.toHaveAttribute('aria-busy', 'true');
    await expect(alice).not.toContainText('Loading chat…');
  });
}

test('shows the folder picker wait and clears it after cancellation', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  const measureFolderControls = () => page.locator('.folder-picker').evaluate(element =>
    [...element.querySelectorAll(':scope > p, :scope > .folder-access-options, :scope > .folder-select-button')].map(control => {
      const rect = control.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
  const originalControls = await measureFolderControls();
  await page.evaluate(() => {
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.webkitdirectory) (window as unknown as { pendingUpload: HTMLInputElement }).pendingUpload = this;
      else originalClick.call(this);
    };
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const waiting = page.locator('.folder-preparation-status');
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeInViewport();
  expect(await measureFolderControls()).toEqual(originalControls);
  await expect(waiting).toContainText('Loading Folder');
  const exampleBounds = (await page.locator('.folder-picker > p').last().boundingBox())!;
  const statusBounds = (await waiting.boundingBox())!;
  expect(statusBounds.y).toBeGreaterThanOrEqual(exampleBounds.y + exampleBounds.height);
  await expectLoadingAnimation(waiting);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectLoadingAnimation(waiting);
  await page.evaluate(() => (window as unknown as { pendingUpload: HTMLInputElement }).pendingUpload.dispatchEvent(new Event('cancel')));
  await expect(waiting).toHaveCount(0);
  expect(await measureFolderControls()).toEqual(originalControls);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Select messages folder|Select folder/ })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopControls = await measureFolderControls();
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(waiting).toBeInViewport();
  expect(await measureFolderControls()).toEqual(desktopControls);
  await page.evaluate(() => (window as unknown as { pendingUpload: HTMLInputElement }).pendingUpload.dispatchEvent(new Event('cancel')));
  await expect(waiting).toHaveCount(0);
  expect(await measureFolderControls()).toEqual(desktopControls);
});

test('animates Loading chats while the selected folder is scanned', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const fixture = window as unknown as { releaseFolderScan?: () => void };
    const readText = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === 'message_1.json' && this.webkitRelativePath.includes('/alice_chat/')) {
        return new Promise<string>((resolve, reject) => {
          fixture.releaseFolderScan = () => { void readText.call(this).then(resolve, reject); };
        });
      }
      return readText.call(this);
    };
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const loading = page.locator('.chat-list-loading');
  await expect(loading).toBeVisible();
  await expect(loading).toContainText('Loading chats');
  await expectLoadingAnimation(loading, false);
  await page.evaluate(() => (window as unknown as { releaseFolderScan: () => void }).releaseFolderScan());
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test('paints preparation feedback before processing a large read-only folder', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.evaluate(() => {
    const fixture = window as unknown as { preparationAtFirstPath?: string; preparedPaths: number; pathsAtTimer?: number };
    fixture.preparedPaths = 0;
    const additionalFiles = Array.from({ length: 20_000 }, (_, index) => {
      const file = new File([], `extra-${index}.jpg`);
      Object.defineProperty(file, 'webkitRelativePath', { get: () => {
        if (fixture.preparedPaths === 0) {
          const status = document.querySelector<HTMLElement>('.folder-preparation-status');
          const rect = status?.getBoundingClientRect();
          fixture.preparationAtFirstPath = rect && rect.height > 0 && getComputedStyle(status!).visibility === 'visible' ? status!.textContent! : '';
          setTimeout(() => { fixture.pathsAtTimer = fixture.preparedPaths; }, 0);
        }
        fixture.preparedPaths++;
        return `messages/inbox/alice_chat/photos/extra-${index}.jpg`;
      } });
      return file;
    });
    const dispatch = HTMLInputElement.prototype.dispatchEvent;
    HTMLInputElement.prototype.dispatchEvent = function (event) {
      if (this.webkitdirectory && event.type === 'change') {
        Object.defineProperty(this, 'files', { configurable: true, value: [...this.files!, ...additionalFiles] });
      }
      return dispatch.call(this, event);
    };
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible({ timeout: 20_000 });
  const observed = await page.evaluate(() => {
    const fixture = window as unknown as { preparationAtFirstPath: string; preparedPaths: number; pathsAtTimer: number };
    return { firstStatus: fixture.preparationAtFirstPath, paths: fixture.preparedPaths, pathsAtTimer: fixture.pathsAtTimer };
  });
  expect(observed.firstStatus).toContain('Loading Folder');
  expect(observed.paths).toBe(20_000);
  expect(observed.pathsAtTimer).toBeGreaterThan(0);
  expect(observed.pathsAtTimer).toBeLessThan(20_000);
  await expect(page.locator('.folder-preparation-status')).toHaveCount(0);
});

for (const accessMode of ['native', 'upload'] as const) {
  test(`caps parallel archive reads and waits for the full list with ${accessMode} access`, async ({ page }) => {
    await installArchive(page, 'facebook', false, false, false, 0, true);
    await page.goto('');
    await page.evaluate(async () => {
      const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
      for (const section of ['archived_threads', 'message_requests', 'e2ee_cutover']) {
        const directory = await root.getDirectoryHandle(section, { create: true });
        for (let index = 0; index < 2; index++) {
          const chat = await directory.getDirectoryHandle(`parallel_${index}`, { create: true });
          const writer = await (await chat.getFileHandle('message_1.json', { create: true })).createWritable();
          await writer.write(JSON.stringify({ title: `Parallel ${section} ${index}`, participants: [{ name: 'Tester' }],
            messages: [{ sender_name: 'Tester', timestamp_ms: index + 1, content: 'parallel preview' }] }));
          await writer.close();
        }
      }
      const alice = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat');
      for (let part = 2; part <= 3; part++) {
        const writer = await (await alice.getFileHandle(`message_${part}.json`, { create: true })).createWritable();
        await writer.write(JSON.stringify({ title: 'Alice Chat', participants: [{ name: 'Tester' }, { name: 'Alice' }],
          messages: [{ sender_name: 'Alice', timestamp_ms: part, content: `parallel part ${part}` }] }));
        await writer.close();
      }
      // Count only reads held by the gate; later reads run normally after releaseAll.
      const reads = { active: 0, peak: 0, started: 0, released: false, pending: [] as Array<() => void>,
        releaseOne() { this.pending.shift()?.(); },
        releaseAll() { this.released = true; this.pending.splice(0).forEach(release => release()); },
      };
      Object.defineProperty(window, '__parallelReads', { value: reads });
      const text = File.prototype.text;
      File.prototype.text = async function () {
        if (this.name !== 'message_1.json' || reads.released) return text.call(this);
        reads.started++;
        reads.active++;
        reads.peak = Math.max(reads.peak, reads.active);
        try {
          await new Promise<void>(resolve => { reads.pending.push(resolve); });
          return await text.call(this);
        } finally { reads.active--; }
      };
    });
    if (accessMode === 'upload') await selectFolderAccess(page, accessMode);
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __parallelReads: { started: number } }).__parallelReads.started)).toBe(4);
    await expect(page.locator('.chat-list-loading')).toContainText('Loading chats');
    await expect(page.locator('.chat-list-item')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __parallelReads: { releaseOne(): void } }).__parallelReads.releaseOne());
    await expect.poll(() => page.evaluate(() => (window as unknown as { __parallelReads: { started: number } }).__parallelReads.started)).toBe(5);
    await expect(page.locator('.chat-list-item')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __parallelReads: { releaseAll(): void } }).__parallelReads.releaseAll());
    const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
    await expect(alice).toBeVisible();
    expect(await page.evaluate(() => {
      const { peak, started } = (window as unknown as { __parallelReads: { peak: number; started: number } }).__parallelReads;
      return { peak, started };
    })).toEqual({ peak: 4, started: 5 });
    const filter = page.getByRole('searchbox', { name: 'Filter chats', exact: true });
    await filter.fill('Parallel');
    await expect(page.locator('.chat-list-item')).toHaveCount(6);
    await filter.fill('');
    await alice.click();
    await expect(page.locator('#chat')).toContainText('needle from Facebook');
    await expect(page.locator('#chat')).toContainText('parallel part 2');
    await expect(page.locator('#chat')).toContainText('parallel part 3');
  });
}

test('saves performance modes and resets both configurations without overflowing mobile settings', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const advanced = page.getByRole('checkbox', { name: 'Advanced performance', exact: true });
  const advancedToggle = page.getByText('Advanced performance', { exact: true });
  const archive = page.getByRole('spinbutton', { name: 'Archive and chat reads', exact: true });
  await expect(advanced).not.toBeChecked();
  const increase = page.getByRole('button', { name: 'Increase archive and chat reads', exact: true });
  const decrease = page.getByRole('button', { name: 'Decrease archive and chat reads', exact: true });
  await increase.click();
  await expect(archive).toHaveValue('5');
  await decrease.click();
  await expect(archive).toHaveValue('4');
  await archive.press('ArrowUp');
  await expect(archive).toHaveValue('5');
  await archive.press('ArrowDown');
  await expect(archive).toHaveValue('4');
  await archive.fill('16');
  await expect(increase).toBeDisabled();
  await decrease.click();
  await expect(archive).toHaveValue('15');
  await archive.fill('1');
  await expect(decrease).toBeDisabled();
  await increase.click();
  await expect(archive).toHaveValue('2');
  await archive.fill('6');
  await page.getByRole('button', { name: 'Background activity', exact: true }).click();
  await page.getByRole('option', { name: 'Ultra', exact: true }).click();
  const openInformation = page.getByRole('button', { name: 'Open performance information', exact: true });
  const information = page.getByRole('dialog', { name: 'Performance', exact: true });
  const stats = information.getByRole('region', { name: 'Current concurrency settings', exact: true });
  await openInformation.click();
  await expect(stats.getByRole('heading', { name: 'Current concurrency settings', exact: true })).toBeVisible();
  await expect(stats).toContainText('Maximum jobs allowed to run at the same time for each operation.');
  await expect(stats).toContainText('Basic · Ultra');
  await expect(stats).toContainText('chat folders or JSON files at a time');
  await expect(stats).toContainText('JSON files at a time');
  await expect(stats).toContainText('video thumbnails at a time');
  await expect(stats.locator('dd')).toHaveText(['6', '4', '8', '8', '16', '16', '16', '4', '4', '16', '4', '1']);
  expect(await information.locator('.settings-info-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await information.screenshot({ path: test.info().outputPath('performance-information.png') });
  await information.getByRole('button', { name: 'Close performance information', exact: true }).click();
  await advancedToggle.click();
  await expect(archive).toHaveValue('4');
  const previews = page.getByRole('spinbutton', { name: 'Chat image previews', exact: true });
  await previews.fill('5');
  await expect(page.getByRole('button', { name: 'Background activity', exact: true })).toHaveText('Ultra - Custom');
  await openInformation.click();
  await expect(stats).toContainText('Advanced · Ultra - Custom');
  await expect(stats.locator('dd')).toHaveText(['4', '4', '5', '8', '16', '16', '16', '4', '4', '16', '4', '1']);
  await information.getByRole('button', { name: 'Close performance information', exact: true }).click();
  await advancedToggle.click();
  await expect(archive).toHaveValue('6');
  await expect(page.getByRole('button', { name: 'Background activity', exact: true })).toContainText('Ultra');
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Background activity', exact: true })).toContainText('Ultra');
  await advancedToggle.click();
  await expect(previews).toHaveValue('5');
  const resetPreview = page.getByRole('button', { name: 'Reset chat image previews', exact: true });
  const resetWidth = await resetPreview.evaluate(element => element.getBoundingClientRect().width);
  await resetPreview.click();
  await expect(previews).toHaveValue('8');
  await expect(resetPreview).toHaveAttribute('data-confirmed', 'true');
  await expect(resetPreview.locator('.reset-button-confirmation')).toBeVisible();
  expect(await resetPreview.evaluate(element => element.getBoundingClientRect().width)).toBe(resetWidth);
  const controls = page.getByRole('region', { name: 'Performance', exact: true });
  await controls.scrollIntoViewIfNeeded();
  expect(await page.locator('.settings-scroll-region').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await controls.screenshot({ path: test.info().outputPath('performance-controls.png') });
  await page.getByRole('button', { name: 'Reset all values', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset all values', exact: true })).toHaveAttribute('data-confirmed', 'true');
  await expect(advanced).toBeChecked();
  await expect(archive).toHaveValue('4');
  await advancedToggle.click();
  await expect(archive).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Background activity', exact: true })).toContainText('Normal');
  await openInformation.click();
  await expect(information).toContainText('Changes apply to queued work immediately');
  await expect(stats).toContainText('Basic · Normal');
  await expect(stats.locator('dd')).toHaveText(['4', '4', '2', '2', '4', '4', '4', '1', '1', '4', '4', '1']);
});

test('uses preset defaults for custom concurrency colors, resets, and reselection', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByText('Advanced performance', { exact: true }).click();
  const preset = page.getByRole('button', { name: 'Background activity', exact: true });
  await preset.click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  const scans = page.getByRole('spinbutton', { name: 'Shared-attachment scans', exact: true });
  const previews = page.getByRole('spinbutton', { name: 'Chat image previews', exact: true });
  const gallery = page.getByRole('spinbutton', { name: 'Gallery image previews', exact: true });
  const video = page.getByRole('spinbutton', { name: 'Chat video previews', exact: true });
  const galleryVideo = page.getByRole('spinbutton', { name: 'Gallery video previews', exact: true });
  const sizes = page.getByRole('spinbutton', { name: 'Size calculations', exact: true });
  await expect(scans).toHaveValue('8');
  await expect(previews).toHaveValue('4');
  await expect(gallery).toHaveValue('8');
  await expect(video).toHaveValue('4');
  await expect(galleryVideo).toHaveValue('8');
  await previews.fill('5');
  await sizes.fill('1');
  await expect(preset).toHaveText('High - Custom');
  const openInfo = page.getByRole('button', { name: 'Open performance information', exact: true });
  const info = page.getByRole('dialog', { name: 'Performance', exact: true });
  const stats = info.getByRole('region', { name: 'Current concurrency settings', exact: true });
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') await page.getByText('Dark mode', { exact: true }).click();
    const colors = theme === 'dark'
      ? { normal: 'rgb(154, 164, 178)', above: 'rgb(130, 167, 200)', below: 'rgb(206, 140, 148)' }
      : { normal: 'rgb(107, 111, 118)', above: 'rgb(76, 115, 153)', below: 'rgb(165, 95, 102)' };
    await expect(scans).toHaveCSS('color', colors.normal);
    await expect(previews).toHaveCSS('color', colors.above);
    await expect(sizes).toHaveCSS('color', colors.below);
    await openInfo.click();
    await expect(stats).toContainText('Advanced · High - Custom');
    await expect(stats.getByText('Shared-attachment scans', { exact: true }).locator('..').locator('..').locator('dd')).toHaveCSS('color', colors.normal);
    await expect(stats.getByText('Chat image previews', { exact: true }).locator('..').locator('..').locator('dd')).toHaveCSS('color', colors.above);
    await expect(stats.getByText('Size calculations', { exact: true }).locator('..').locator('..').locator('dd')).toHaveCSS('color', colors.below);
    expect(await info.locator('.settings-info-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await info.screenshot({ path: test.info().outputPath(`performance-custom-${theme}.png`) });
    await info.getByRole('button', { name: 'Close performance information', exact: true }).click();
  }
  await video.fill('3');
  await galleryVideo.fill('5');
  await expect(video).toHaveValue('3');
  await expect(galleryVideo).toHaveValue('5');
  await page.getByRole('button', { name: 'Reset chat video previews', exact: true }).click();
  await expect(video).toHaveValue('4');
  await expect(galleryVideo).toHaveValue('5');
  await page.getByRole('button', { name: 'Reset gallery video previews', exact: true }).click();
  await expect(galleryVideo).toHaveValue('8');
  await preset.click();
  await expect(page.getByRole('option')).toHaveText(['Low', 'Normal', 'High', 'Ultra']);
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await expect(preset).toHaveText('High');
  await expect(previews).toHaveValue('4');
  await expect(gallery).toHaveValue('8');
  await expect(video).toHaveValue('4');
  await expect(galleryVideo).toHaveValue('8');
  await expect(sizes).toHaveValue('2');
  await expect(scans).toHaveValue('8');
  await preset.click();
  await page.getByRole('option', { name: 'Ultra', exact: true }).click();
  await expect(previews).toHaveValue('8');
  await expect(gallery).toHaveValue('16');
  await expect(video).toHaveValue('8');
  await expect(galleryVideo).toHaveValue('16');
  await gallery.fill('12');
  await expect(preset).toHaveText('Ultra - Custom');
  await page.getByRole('button', { name: 'Reset gallery image previews', exact: true }).click();
  await expect(gallery).toHaveValue('16');
  await expect(gallery).toHaveAttribute('data-comparison', 'default');
  await expect(preset).toHaveText('Ultra');
});

for (const accessMode of ['native', 'upload'] as const) {
  test(`changes pending archive reads immediately through performance controls with ${accessMode} access`, async ({ page }) => {
    await installArchive(page, 'facebook', false, false, false, 0, true);
    await page.goto('');
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const archive = page.getByRole('spinbutton', { name: 'Archive and chat reads', exact: true });
    await archive.fill('2');
    if (accessMode === 'upload') await selectFolderAccess(page, accessMode);
    await page.evaluate(async () => {
      const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
      const inbox = await root.getDirectoryHandle('inbox');
      for (let index = 0; index < 6; index++) {
        const chat = await inbox.getDirectoryHandle(`live_${index}`, { create: true });
        const writer = await (await chat.getFileHandle('message_1.json', { create: true })).createWritable();
        await writer.write(JSON.stringify({ title: `Live ${index}`, participants: [{ name: 'Owner' }], messages: [{ timestamp_ms: index + 1, content: 'Live preview' }] }));
        await writer.close();
      }
      const reads = { started: 0, active: 0, released: false, pending: [] as Array<() => void>,
        release(count: number) { this.pending.splice(0, count).forEach(release => release()); },
        releaseAll() { this.released = true; this.pending.splice(0).forEach(release => release()); },
      };
      Object.defineProperty(window, '__liveReads', { value: reads });
      const text = File.prototype.text;
      File.prototype.text = async function() {
        if (this.name !== 'message_1.json' || reads.released) return text.call(this);
        reads.started++; reads.active++;
        try { await new Promise<void>(resolve => reads.pending.push(resolve)); return await text.call(this); }
        finally { reads.active--; }
      };
    });
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    const stats = () => page.evaluate(() => {
      const reads = (window as unknown as { __liveReads: { started: number; active: number } }).__liveReads;
      return { started: reads.started, active: reads.active };
    });
    await expect.poll(stats).toEqual({ started: 2, active: 2 });
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await archive.fill('4');
    await expect.poll(stats).toEqual({ started: 4, active: 4 });
    await archive.fill('1');
    await page.evaluate(() => (window as unknown as { __liveReads: { release(count: number): void } }).__liveReads.release(2));
    await expect.poll(stats).toEqual({ started: 4, active: 2 });
    await page.evaluate(() => (window as unknown as { __liveReads: { release(count: number): void } }).__liveReads.release(2));
    await expect.poll(stats).toEqual({ started: 5, active: 1 });
    await page.evaluate(() => (window as unknown as { __liveReads: { releaseAll(): void } }).__liveReads.releaseAll());
    await page.getByRole('tab', { name: 'Chats', exact: true }).click();
    await expect(page.locator('.chat-list-item')).toHaveCount(8);
    await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
    await expect(page.locator('#chat')).toContainText('needle from Facebook');
  });
}

test('opens a valid folder through the mobile upload picker', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await expect(page.locator('#chat')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await expect(page.locator('#chat .message')).not.toHaveCount(0);
  await expectScreen(page, 'chat');
});

test('native mobile folder access saves bookmarks and deletes original chat folders', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await expect(page.getByRole('button', { name: 'Folder access', exact: true })).toContainText('Native access');
  await page.evaluate(() => {
    const picker = window.showDirectoryPicker;
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: (options?: Parameters<typeof picker>[0]) => {
        sessionStorage.setItem('__nativePickerMode', options?.mode || 'read');
        return picker.call(window, options);
      } });
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(alice).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('__nativePickerMode'))).toBe('readwrite');
  await holdChatRow(page, 'Alice Chat');
  await page.getByRole('button', { name: 'Pin to top', exact: true }).click();
  await expect(alice.getByLabel('Pinned chat', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const file = await (await root.getDirectoryHandle('fb-mae')).getFileHandle('bookmarks.json');
    return JSON.parse(await (await file.getFile()).text()).pinnedChats.length;
  })).toBe(1);
  await holdChatRow(page, 'Alice Chat');
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Delete permanently', exact: true });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(alice).toHaveCount(0);
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    try { await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat'); return false; }
    catch (error) { return error instanceof DOMException && error.name === 'NotFoundError'; }
  })).toBe(true);
});

for (const width of [390, 1280]) {
  test(`keeps compact settings groups and title information usable at ${width}px`, async ({ page }) => {
    await installArchive(page, 'facebook');
    await page.addInitScript(() => {
      localStorage.setItem(`majv_${location.hostname}_setting_sidebarWidth`, '480');
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const sections = page.locator('.settings-section-toggle');
    await expect(sections.nth(0)).toHaveText('Messages folder');
    await expect(sections.nth(1)).toHaveText('Appearance');
    for (const toggle of await sections.all()) await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const folderAccess = (await page.getByRole('button', { name: 'Folder access', exact: true }).boundingBox())!;
    const matching = (await page.getByRole('button', { name: 'Reaction timestamp matching', exact: true }).boundingBox())!;
    expect(Math.abs(folderAccess.width - matching.width)).toBeLessThan(1);
    const appearance = page.getByRole('button', { name: 'Appearance', exact: true });
    await expect(appearance).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: test.info().outputPath(`settings-${width}.png`) });

    const name = page.getByRole('checkbox', { name: 'Show my name', exact: true });
    const wasChecked = await name.isChecked();
    await page.locator('label[for="showMyNameToggle"]').click();
    await appearance.focus();
    await appearance.press(' ');
    await expect(name).toBeHidden();

    const info = page.getByRole('button', { name: 'Open appearance information', exact: true });
    await info.click();
    const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
    const close = dialog.getByRole('button', { name: 'Close appearance information', exact: true });
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.shortcuts-body')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('.shortcuts-body')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(info).toBeFocused();
    await expect(appearance).toHaveAttribute('aria-expanded', 'false');
    await appearance.focus();
    await appearance.press('Enter');
    await expect(name).toHaveJSProperty('checked', !wasChecked);

    for (const title of ['Messages folder', 'Chat management', 'Reaction notices', 'Downloads', 'Offline use']) {
      const toggle = page.getByRole('button', { name: title, exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: `Open ${title.toLowerCase()} information`, exact: true }).click();
      const panel = page.getByRole('dialog', { name: title, exact: true });
      await expect(panel).toBeVisible();
      if (title === 'Messages folder') await expect(panel).toContainText('may temporarily freeze your browser');
      if (title === 'Chat management') await expect(panel).toContainText('fb-mae/bookmarks.json');
      const rows = await panel.locator('.shortcut-row').evaluateAll(elements => elements.map(row => ({
        label: row.querySelector('.shortcut-keys')!.getBoundingClientRect().toJSON(),
        description: row.querySelector(':scope > span:last-child')!.getBoundingClientRect().toJSON(),
      })));
      for (const { label, description } of rows) {
        expect(description.x).toBeGreaterThan(label.x + label.width);
        expect(Math.min(label.y + label.height, description.y + description.height))
          .toBeGreaterThan(Math.max(label.y, description.y));
      }
      expect(await panel.locator('.shortcuts-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (title === 'Reaction notices') {
        await page.screenshot({ path: test.info().outputPath(`reaction-notices-${width}.png`) });
      }
      await panel.getByRole('button', { name: `Close ${title.toLowerCase()} information`, exact: true }).click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }

    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    const template = page.getByRole('textbox', { name: 'Filename template', exact: true });
    await template.fill('saved_{date}');
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    await expect(template).toBeHidden();
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    await expect(template).toHaveValue('saved_{date}');
    await expect(page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Facebook Download Your Information', exact: true })).toBeVisible();
    expect(await page.locator('.settings-scroll-region').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test('debugging starts disabled and saves the selected option', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => { throw new DOMException('Requested document not found', 'NotFoundError'); } });
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const error = page.locator('.sidebar-error-alert');
  await expect(error).toContainText('Requested document not found');
  await expect(error).not.toContainText('Native folder details:');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const debugging = page.getByRole('checkbox', { name: 'Enable debugging', exact: true });
  const toggle = page.locator('label[for="debuggingEnabledToggle"]');
  await expect(debugging).not.toBeChecked();
  await toggle.click();
  await expect(error).toContainText('Native folder details:');
  await expect(error).toContainText('operation=showDirectoryPicker()');
  await toggle.click();
  await expect(error).toContainText('Requested document not found');
  await expect(error).not.toContainText('Native folder details:');
  await toggle.click();
  await page.getByRole('button', { name: 'Open debugging information', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Debugging', exact: true });
  await expect(info).toContainText('detailed folder errors and attachment file details');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(debugging).toBeChecked();
  await toggle.click();
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(debugging).not.toBeChecked();
});

test('debugging controls whether attachment file details are available', async ({ page }) => {
  await installArchive(page, 'messenger', false, false, false, 0, true, 'Download', true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await alice.click();
  await expect(page.locator('#chat')).toContainText('needle from Messenger');
  await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
  await expect(page.locator('.attachment-file-details')).toHaveCount(0);
  for (const enabled of [true, false]) {
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat list', exact: true }).click();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.locator('label[for="debuggingEnabledToggle"]').click();
    await expect(page.getByRole('checkbox', { name: 'Enable debugging', exact: true })).toBeChecked({ checked: enabled });
    await page.getByRole('tab', { name: 'Chats', exact: true }).click();
    await alice.click();
    await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
    const details = page.locator('.attachment-file-details');
    await expect(details).toHaveCount(enabled ? 1 : 0);
    if (enabled) {
      await details.locator('summary').click();
      await expect(details.locator('pre')).toContainText('Matched references: 3');
    }
  }
});

test('read-only mobile access disables write actions and native reopening restores preferences', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await holdChatRow(page, 'Alice Chat');
  await expect(page.getByRole('button', { name: 'Pin to top', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete chat', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const bookmarkToggle = page.getByLabel('Enable bookmarking', { exact: true });
  const deleteToggle = page.getByLabel('Enable chat deletion', { exact: true });
  await expect(bookmarkToggle).toBeDisabled();
  await expect(deleteToggle).toBeDisabled();
  await selectFolderAccess(page, 'native');
  await expect(bookmarkToggle).toBeDisabled();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(bookmarkToggle).toBeEnabled();
  await expect(bookmarkToggle).toBeChecked();
  await expect(deleteToggle).toBeEnabled();
  await expect(deleteToggle).toBeChecked();
});

for (const { prefix, flat } of [
  { prefix: '', flat: false }, { prefix: 'Download', flat: false }, { prefix: 'storage/Download', flat: false },
  { prefix: 'Download', flat: true },
]) {
  test(`opens a standalone Messenger export through read-only mobile access (${prefix || 'no wrapper'}${flat ? ', flat files' : ''})`, async ({ page }) => {
    await installArchive(page, 'messenger', false, false, false, 0, true, prefix, flat);
    await enableDebuggingOnLoad(page);
    await page.goto('');
    await setMessengerPhoto(page);
    await selectFolderAccess(page, 'upload');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
    await expect(alice).toBeVisible();
    await expect(page.locator('.chat-list-item').filter({ hasText: 'Messenger Group' })).toBeVisible();
    await alice.click();
    await expect(page.locator('#chat')).toContainText('needle from Messenger');
    await expect(page.locator('.sidebar-error-alert')).toHaveCount(0);
    const photo = page.locator('#chat img.preview').first();
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
    await page.locator('.attachment-file-details summary').click();
    const details = page.locator('.attachment-file-details pre');
    await expect(details).toContainText('Matched references: 3');
    await expect(details).toContainText('Sample file bytes: OK');
    if (flat) {
      await expect(details).toContainText('Root listing: OK (5 files, 0 folders)');
      await expect(details).toContainText('Attachment lookup: uploaded root files');
    } else await expect(details).toContainText('Attachment lookup: media folder');
    await page.getByRole('button', { name: 'Attachments', exact: true }).click();
    await page.locator('.gallery-thumb[title="photo.jpg"]').click();
    await expect.poll(() => page.locator('.media-viewer-image').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(12);
  });
}

for (const failure of ['missing folder', 'unreadable bytes']) {
  test(`read-only attachment details identify ${failure}`, async ({ page }) => {
    await installArchive(page, 'messenger', false, false, false, 0, true, 'Download');
    await enableDebuggingOnLoad(page);
    await page.goto('');
    await setMessengerPhoto(page);
    await page.evaluate(async failure => {
      if (failure === 'missing folder') {
        const fixture = window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } };
        const media = await fixture.__testArchives.messenger.getDirectoryHandle('media');
        media.entries = async function* () { yield* []; };
      } else {
        const arrayBuffer = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function () {
          if (this.size === 1) return Promise.reject(new DOMException('File bytes unavailable', 'NotReadableError'));
          return arrayBuffer.call(this);
        };
      }
    }, failure);
    await selectFolderAccess(page, 'upload');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' }).click();
    await expect(page.locator('#chat')).toContainText('needle from Messenger');
    await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
    await page.locator('.attachment-file-details summary').click();
    const details = page.locator('.attachment-file-details pre');
    await expect(details).toContainText('Attachment references: 3');
    if (failure === 'missing folder') {
      await expect(details).toContainText('Matched references: 0');
      await expect(details).toContainText('Media folder lookup: NotFoundError');
    } else {
      await expect(details).toContainText('Matched references: 3');
      await expect(details).toContainText('Sample getFile(): OK');
      await expect(details).toContainText('Sample file bytes: NotReadableError');
    }
    await expect(details).not.toContainText('photo.jpg');
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test('reports browser folder details when a read-only Messenger upload is rejected', async ({ page }) => {
  await installArchive(page, 'messenger');
  await enableDebuggingOnLoad(page);
  await page.goto('');
  await selectFolderAccess(page, 'upload');
  await page.evaluate(() => {
    HTMLInputElement.prototype.click = function () {
      const file = new File([''], 'private-conversation.json');
      Object.defineProperty(file, 'webkitRelativePath', { value: 'messenger/private-conversation.json' });
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    };
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const error = page.locator('.sidebar-error-alert');
  await expect(error).toContainText('1 JSON files (1 invalid, 0 unrecognized, 1 empty)');
  await expect(error).toContainText('Folder upload: 1 files, 1 JSON filenames, 1 JSON paths, 1 top-level JSON files');
  await expect(error).not.toContainText('private-conversation');
  await expect(page.getByRole('button', { name: /Select messages folder|Select folder/ })).toBeEnabled();
});

test('native mobile picker failure allows retrying with read-only access', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await enableDebuggingOnLoad(page);
  await page.goto('');
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => { throw new DOMException('Native permission denied', 'NotAllowedError'); } });
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.sidebar-error-alert')).toContainText('Native permission denied');
  await expect(page.locator('.sidebar-error-alert')).toContainText('Read-only access');
  await expect(page.locator('.sidebar-error-alert')).toContainText('stage=folder picker; operation=showDirectoryPicker()');
  await expect(page.locator('.sidebar-error-alert')).toContainText('picker returned=no; requested permission=readwrite; error=NotAllowedError');
  await selectFolderAccess(page, 'upload');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await expect(page.locator('.sidebar-error-alert')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Folder access', exact: true })).toContainText('Read-only access');
});

for (const operation of ['entries()', 'getFile()', 'File.text()']) {
  test(`native mobile failure reports ${operation} in the visible error`, async ({ page }) => {
    await installArchive(page, 'messenger');
    await enableDebuggingOnLoad(page);
    await page.goto('');
    await page.evaluate(async operation => {
      const fixture = window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } };
      const root = fixture.__testArchives.messenger;
      if (operation === 'entries()') {
        root.entries = () => { throw new DOMException('Requested directory not found', 'NotFoundError'); };
      } else {
        const alice = await root.getFileHandle('alice.json');
        root.entries = async function* () { yield ['alice.json', alice]; };
        if (operation === 'getFile()') {
          alice.getFile = async () => { throw new DOMException('Requested document not found', 'NotFoundError'); };
        } else {
          const file = await alice.getFile();
          file.text = async () => { throw new DOMException('Requested document not found', 'NotFoundError'); };
          alice.getFile = async () => file;
        }
      }
    }, operation);
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    const error = page.locator('.sidebar-error-alert');
    await expect(error).toBeVisible();
    await expect(error).toContainText(`stage=Messenger detection; operation=${operation}; folder depth=0`);
    await expect(error).toContainText('picker returned=yes; requested permission=readwrite; error=NotFoundError');
    if (operation === 'getFile()') await expect(error).toContainText('reopen operation=getFile(); reopen error=NotFoundError');
    await expect(error).not.toContainText('alice.json');
    await expect(page.getByRole('button', { name: /Select messages folder|Select folder/ })).toBeEnabled();
    expect(await error.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test('native mobile access reopens unreadable enumerated files by name', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  await setMessengerPhoto(page);
  await page.evaluate(async () => {
    const fixture = window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } };
    const root = fixture.__testArchives.messenger;
    const breakListedFiles = async (directory: FileSystemDirectoryHandle) => {
      const entries = directory.entries.bind(directory);
      const directories: FileSystemDirectoryHandle[] = [];
      for await (const [, entry] of entries()) if (entry.kind === 'directory') directories.push(entry);
      directory.entries = async function* () {
        for await (const [name, entry] of entries()) yield [name, entry.kind === 'directory' ? entry : {
          kind: 'file', name,
          getFile: async () => { throw new DOMException('Listed document not found', 'NotFoundError'); },
        } as FileSystemFileHandle];
      };
      for (const directory of directories) await breakListedFiles(directory);
    };
    await breakListedFiles(root);
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await expect(alice).toBeVisible();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Messenger Group' })).toBeVisible();
  await expect(page.locator('.sidebar-error-alert')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Enable bookmarking', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Enable chat deletion', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Chats', exact: true }).click();
  await alice.click();
  await expect(page.locator('#chat')).toContainText('needle from Messenger');
  await openGallery(page);
  await page.locator('.gallery-thumb[title="photo.jpg"]').click();
  await expect.poll(() => page.locator('.media-viewer-image').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(12);
});

test('mobile browsers without native access use the read-only picker', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  });
  await page.goto('');
  const choice = page.getByRole('button', { name: 'Folder access', exact: true });
  await expect(choice).toContainText('Read-only access');
  await choice.click();
  await expect(page.getByRole('option', { name: 'Native access', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Enable bookmarking', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Enable chat deletion', { exact: true })).toBeDisabled();
});

test('a failed native folder change offers read-only retry from mobile settings', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, false, 0, true);
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => { throw new DOMException('Native folder change failed', 'NotReadableError'); } });
  });
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Native folder change failed');
  await expect(page.getByRole('alert')).toContainText('Read-only access');
  await expect(page.getByLabel('Enable bookmarking', { exact: true })).toBeEnabled();
  await selectFolderAccess(page, 'upload');
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Enable bookmarking', { exact: true })).toBeDisabled();
});

for (const scale of ['Week', 'Day']) {
  for (const returnMethod of ['parent', 'browser']) {
    test(`applies the ${scale} slider selection on ${returnMethod} return to chat`, async ({ page }) => {
      await openChat(page, 320);
      await page.getByRole('button', { name: 'Open chat info', exact: true }).click();
      await page.locator('.mobile-date-section summary').click();
      await page.getByRole('button', { name: scale, exact: true }).click();
      const historyLength = await page.evaluate(() => history.length);
      const slider = page.locator('.mobile-date-section input[type="range"]');
      await slider.focus();
      await slider.press('Home');
      await slider.press('ArrowRight');
      await expect(slider).toHaveValue('1');
      await expectScreen(page, 'info');
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      if (returnMethod === 'browser') await page.evaluate(() => history.back());
      else await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expectScreen(page, 'chat');
      await expect(page.locator('#chat .message.highlight-target')).toContainText('History message 0 ');
      await expect(page.locator('#chat .message.highlight-target')).toBeInViewport();
    });
  }
}

test('restores message positions for date jumps and gallery filters after preview jumps', async ({ page }) => {
  await openChat(page, 120);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
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
  const targetIndex = await page.locator('.message.highlight-target').getAttribute('data-msg-index');
  await page.evaluate(() => history.back());
  await expectScreen(page, 'info');
  await expect.poll(() => page.locator('#chat').evaluate(element => element.scrollTop)).toBeGreaterThan(before - 20);
  await page.evaluate(() => history.forward());
  await expectScreen(page, 'chat');
  await expect(page.locator(`.message[data-msg-index="${targetIndex}"]`)).toBeInViewport();
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

for (const source of ['chat', 'gallery', 'selected'] as const) {
  for (const startMobile of [true, false]) {
    test(`closes returned ${source} previews once after resizing from ${startMobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
      if (source === 'selected' && !startMobile) await page.addInitScript(() => {
        localStorage.setItem('majv_' + location.hostname + '_setting_infoPanelOpen', 'true');
      });
      await page.setViewportSize({ width: startMobile || source === 'selected' ? 390 : 1280, height: 844 });
      await openChat(page, source === 'chat' ? 0 : 80, true);
      if (source !== 'chat') {
        await page.getByRole('button', { name: startMobile || source === 'selected' ? 'Open chat info' : 'Toggle chat info panel', exact: true }).click();
        await page.getByRole('button', { name: 'Attachments', exact: true }).click();
        await page.locator('.gallery-tab').filter({ hasText: 'Photos' }).click();
        if (source === 'selected') {
          await page.getByTitle('Select attachments and links', { exact: true }).click();
          await page.locator('.gallery-thumb').first().click();
          await page.getByRole('button', { name: 'Review selection', exact: true }).click();
          if (!startMobile) await page.setViewportSize({ width: 1280, height: 844 });
          const selected = page.locator('.selection-panel .gallery-thumb').first();
          if (startMobile) await selected.click();
          else await selected.locator('.gallery-open-viewer-btn').click();
        } else await page.locator('.gallery-thumb').first().click();
      } else {
        const attachment = page.locator('#chat .lazy-media-wrapper').first();
        await attachment.scrollIntoViewIfNeeded();
        await expect(attachment.locator('img')).toBeVisible();
        await attachment.locator('img').click();
      }
      const viewer = page.locator('.media-viewer-overlay');
      await expect(viewer).toBeVisible();
      const date = await viewer.locator('.media-viewer-date').textContent();
      await viewerAction(page, source === 'chat' ? 'Jump to attachment' : 'Jump to message');
      await page.setViewportSize({ width: startMobile ? 1280 : 390, height: 844 });
      await page.getByRole('button', { name: source === 'chat' ? 'Return to message' : 'Return to attachment', exact: true }).click();
      await expect(viewer.locator('.media-viewer-date')).toHaveText(date!);
      const historyLength = await page.evaluate(() => history.length);
      await viewer.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(viewer).toHaveCount(0);
      await expectScreen(page, source === 'selected' && !startMobile ? 'gallery' : source);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      if (source !== 'chat') await expect(page.locator('.gallery-tab.active')).toContainText('Photos');
      else await expect(page.locator('#chat .message')).not.toHaveCount(0);
    });
  }
}

test('fits every attachment type between mobile viewer controls in portrait and landscape', async ({ page }) => {
  test.setTimeout(120_000);
  const layoutOnlyMedia = process.platform === 'win32' && test.info().project.name.includes('webkit');
  if (layoutOnlyMedia) {
    test.info().annotations.push({ type: 'platform', description: 'Windows WebKit cannot decode these media fixtures; native-element sizing is tested with deterministic dimensions. Chromium verifies playback.' });
    await page.addInitScript(() => {
      document.addEventListener('error', event => {
        if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
      }, true);
      new MutationObserver(() => {
        const video = document.querySelector<HTMLVideoElement>('.media-viewer-video');
        if (video && !video.hasAttribute('width')) {
          video.width = 120; video.height = 360;
        }
      }).observe(document, { childList: true, subtree: true });
    });
  }
  await openChat(page, 0, true, false, true);
  await openGallery(page);
  for (const [width, height] of [[320, 640], [390, 844], [640, 320]]) {
    await page.setViewportSize({ width, height });
    for (const [title, selector] of [
      ['portrait.mp4', '.media-viewer-video'], ['silence.wav', '.media-viewer-audio-wrap'],
      ['sample.txt', '.media-viewer-placeholder'], ['https://example.com/report', '.media-viewer-link-card'],
    ]) {
      await page.locator(`.gallery-thumb[title="${title}"]`).click();
      const viewer = page.locator('.media-viewer-overlay');
      const content = viewer.locator(selector);
      await expect(content).toBeVisible();
      const media = viewer.locator('video, audio');
      if (!layoutOnlyMedia && await media.count()) {
        await expect.poll(() => media.evaluate(element => (element as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(2);
        await media.evaluate(async element => { const media = element as HTMLMediaElement; media.loop = true; await media.play(); });
      }
      for (const navigation of [true, false]) {
        const visible = await viewer.locator('.media-viewer-navigation').count() > 0;
        if (visible !== navigation) await viewerAction(page, navigation ? 'Show Navigation' : 'Hide Navigation');
        await expect.poll(() => content.evaluate(element => {
          const box = element.getBoundingClientRect();
          const header = document.querySelector('.media-viewer-topbar')!.getBoundingClientRect();
          const footer = document.querySelector('.media-viewer-navigation')?.getBoundingClientRect();
          return box.top >= header.bottom + 11.9 && box.bottom <= (footer?.top ?? innerHeight) - 11.9;
        })).toBe(true);
        if (navigation) {
          const footer = viewer.locator('.media-viewer-navigation');
          const footerHit = await footer.evaluate(element => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { pointer: getComputedStyle(element).pointerEvents, hit: hit?.outerHTML.slice(0, 200),
              blocked: !!hit?.closest('.media-viewer-navigation') };
          });
          expect(footerHit.blocked, `${width}x${height} ${title}: ${JSON.stringify(footerHit)}`).toBe(false);
          for (const button of await footer.getByRole('button').all()) expect((await button.boundingBox())!.height).toBe(44);
        }
        if (await media.count()) {
          await media.scrollIntoViewIfNeeded();
          expect(await media.evaluate(element => {
            const box = element.getBoundingClientRect();
            return document.elementFromPoint(box.x + box.width / 2, box.bottom - 8) === element;
          })).toBe(true);
        }
        const lastAction = content.locator('button, a, audio, video').last();
        if (await lastAction.count()) {
          await lastAction.scrollIntoViewIfNeeded();
          expect(await lastAction.evaluate(element => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit === element || element.contains(hit);
          })).toBe(true);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await viewer.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(viewer).toHaveCount(0);
      await expectScreen(page, 'gallery');
    }
  }
});

test('does not activate viewer buttons or links after a moved touch', async ({ page }) => {
  await openChat(page, 0, true);
  await openGallery(page);
  await page.getByTitle('Select attachments and links', { exact: true }).click();
  await page.locator('.gallery-thumb[title="photo.jpg"]').click();
  await page.getByRole('button', { name: 'Review selection' }).click();
  await page.locator('.selection-panel .gallery-thumb').click();
  const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
  const drag = async (control: Locator) => {
    const target = control.locator('svg').first();
    const pointer = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20 };
    await target.dispatchEvent('pointerdown', pointer);
    await target.dispatchEvent('pointermove', { ...pointer, clientX: 44 });
    await target.dispatchEvent('pointerup', pointer);
    await target.dispatchEvent('click', { detail: 1 });
  };
  for (const name of ['Deselect item', 'Close', 'More options']) {
    await drag(viewer.getByRole('button', { name, exact: true }));
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Deselect item' })).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'false');
  }
  await viewer.getByRole('button', { name: 'More options' }).tap();
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await drag(viewer.getByRole('button', { name: 'Download', exact: true }));
  expect(downloads).toBe(0);
  await expect(viewer.locator('.media-viewer-menu-dropdown')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).tap();
  await page.getByRole('button', { name: 'Back to attachments' }).click();
  await page.getByTitle('Select attachments and links', { exact: true }).click();
  await page.locator('.gallery-tab').filter({ hasText: 'Links' }).click();
  await page.locator('.gallery-link-card').click();
  await viewer.getByRole('button', { name: 'More options' }).tap();
  const pageCount = page.context().pages().length;
  await drag(viewer.getByRole('link', { name: 'Open link', exact: true }).first());
  expect(page.context().pages()).toHaveLength(pageCount);
  await expect(viewer).toBeVisible();
});

test('keeps the mobile viewer backdrop clickable outside the fitted attachment', async ({ page }) => {
  await openChat(page, 0, true);
  await openGallery(page);
  await page.locator('.gallery-thumb[title="photo.jpg"]').tap();
  const viewer = page.locator('.media-viewer-overlay');
  await expect(viewer.locator('.media-viewer-image')).toBeVisible();
  const content = (await viewer.locator('.media-viewer-content').boundingBox())!;
  const position = { x: content.x + 8, y: content.y + content.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('media-viewer-overlay'), position)).toBe(true);
  await page.touchscreen.tap(position.x, position.y);
  await expect(viewer).toHaveCount(0);
  await expectScreen(page, 'gallery');
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
    // The second open uses a decoded image and saved visible navigation.
    for (const navigation of [false, true]) {
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
      const contentHeight = await page.locator('.media-viewer-overlay').evaluate(element => parseFloat((element as HTMLElement).style.getPropertyValue('--viewer-content-height')));
      const fittedWidth = Math.min(120, width, contentHeight / 3);
      for (const frame of frames) {
        expect(frame.width).toBeLessThanOrEqual(fittedWidth + 1);
        expect(frame.height).toBeLessThanOrEqual(fittedWidth * 3 + 1);
      }
      expect(frames.at(-1)!.width).toBeCloseTo(fittedWidth, 0);
      await viewerAction(page, navigation ? 'Hide Navigation' : 'Show Navigation');
      await page.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(page.locator('.media-viewer-overlay')).toHaveCount(0);
      await expectScreen(page, 'gallery');
    }
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
      timestamp_ms: 1761836520000 + Math.floor((index + 1) / 4) * 3600000 + index * 1000,
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

test('avoids duplicate mobile dates for messages with their own separator', async ({ page }) => {
  await openChat(page);
  const first = page.locator('.message').filter({ hasText: 'first message' });
  const next = page.locator('.message').filter({ hasText: 'needle from Facebook' });
  const separator = page.locator('#chat .time-separator:not(.mobile-msg-timestamp)');
  const existingDate = await separator.textContent();
  await expect(first.locator('.msg-timestamp')).toHaveText(existingDate!);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await tapWithoutMovingFollowingMessages(page, first);
    await tapWithoutMovingFollowingMessages(page, first);
    await expect(first).not.toHaveAttribute('data-timestamp-visible', 'true');
    await expect(first.locator('..').locator('.mobile-msg-timestamp')).toBeHidden();
    await expect(separator).toHaveCount(1);
    await expect(separator).toHaveText(existingDate!);
    await tapWithoutMovingFollowingMessages(page, next);
    await expect(next.locator('..').locator('.mobile-msg-timestamp')).toBeVisible();
    await first.locator('.message-text').scrollIntoViewIfNeeded();
    const before = await first.boundingBox();
    await first.locator('.message-text').tap();
    await expect(next.locator('..').locator('.mobile-msg-timestamp')).toBeHidden();
    await expect(first.locator('..').locator('.mobile-msg-timestamp')).toBeHidden();
    await expect.poll(async () => Math.abs((await first.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(0.02);
    await expect(separator).toHaveText(existingDate!);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await first.hover();
  await expect(first.locator('.msg-timestamp')).toHaveCSS('opacity', '1');
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
  await openChat(page, 40, false, false, false, useNearbyMessageTimes);
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

test('keeps a revealed date through delayed media sizing and live orientation changes', async ({ page }) => {
  test.setTimeout(90_000);
  let release = () => {};
  const mediaReady = new Promise<void>(resolve => { release = resolve; });
  let pendingRequests = 0;
  try {
    await openChat(page, 40, true, false, false, async page => {
      await useNearbyMessageTimes(page);
      const bytes = await page.evaluate(async () => {
        const fixture = window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } };
        const inbox = await fixture.__testArchives.facebook.getDirectoryHandle('inbox');
        const alice = await inbox.getDirectoryHandle('alice_chat');
        const photos = await alice.getDirectoryHandle('photos');
        const file = await photos.getFileHandle('photo.jpg');
        const bytes = [...new Uint8Array(await (await file.getFile()).arrayBuffer())];
        const create = URL.createObjectURL.bind(URL);
        // Exercise the supported image-element decoding path so the request can be held.
        Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined });
        URL.createObjectURL = blob => blob instanceof File && blob.name === 'photo.jpg'
          ? new URL('e2e-delayed-photo.png', location.href).href : create(blob);
        return bytes;
      });
      await page.route('**/e2e-delayed-photo.png', async route => {
        pendingRequests++;
        await mediaReady;
        await route.fulfill({ body: Buffer.from(bytes), contentType: 'image/png' });
      });
    });
    const message = page.locator('.message').filter({ hasText: 'History message 37 with enough text' });
    await tapWithoutMovingFollowingMessages(page, message);
    const date = message.locator('..').locator('.mobile-msg-timestamp');
    await expect(date).toBeVisible();
    await expect.poll(() => pendingRequests).toBeGreaterThan(0);
    release();
    await expect.poll(() => page.locator('#chat img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalHeight > 0))).toBe(true);
    await expect(date).toBeVisible();
    // Media dimensions may change legitimately; compare timestamp taps only once sizing settles.
    await tapWithoutMovingFollowingMessages(page, message);
    await tapWithoutMovingFollowingMessages(page, message);
    for (const [width, height] of [[320, 640], [640, 320], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(date).toBeVisible();
      await expect.poll(() => date.evaluate(element => {
        const style = getComputedStyle(element);
        const outer = element.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        return Math.max(Math.abs(outer - Math.round(outer)), Math.abs(outer * devicePixelRatio - Math.round(outer * devicePixelRatio)));
      })).toBeLessThanOrEqual(0.02);
      await tapWithoutMovingFollowingMessages(page, message);
      await tapWithoutMovingFollowingMessages(page, message);
    }
  } finally { release(); }
});

test('reveals mobile dates above tapped messages without moving the tapped bubble', async ({ page }) => {
  await openChat(page, 20, false, false, false, useNearbyMessageTimes);
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
