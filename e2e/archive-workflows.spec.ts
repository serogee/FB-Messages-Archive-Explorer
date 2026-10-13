import { expect, test, type Page } from '@playwright/test';

async function installArchive(page: Page, format: 'facebook' | 'instagram' | 'messenger', failMessengerMediaOnce = false, unavailableMedia = false, bumpedMessages = false) {
  await page.addInitScript(({ selectedFormat, shouldFailMessengerMediaOnce, includeUnavailableMedia, includeBumpedMessages }) => {
    let failBlockedMedia = shouldFailMessengerMediaOnce;
    const makeFile = (name: string, initialContents: string | number[], persistKey?: string) => {
      let contents = initialContents;
      return {
      kind: 'file',
      name,
      async getFile() {
        return new File(
          [Array.isArray(contents) ? new Uint8Array(contents) : contents],
          name,
          { type: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
        );
      },
      async createWritable() {
        return {
          async write(value: unknown) {
            if (typeof value === 'string') contents = value;
            else if (value instanceof Blob) contents = await value.text();
            else if (value instanceof Uint8Array) contents = Array.from(value);
            if (persistKey && typeof contents === 'string') sessionStorage.setItem(persistKey, contents);
          },
          async close() {},
        };
      },
    }};
    const makeDirectory = (name: string, initial: Record<string, ReturnType<typeof makeFile> | ReturnType<typeof makeDirectory>>) => {
      const children = new Map(Object.entries(initial));
      return {
        kind: 'directory',
        name,
        async getDirectoryHandle(childName: string, options?: { create?: boolean }) {
          const child = children.get(childName);
          if (child?.kind === 'directory') return child;
          if (options?.create) {
            const created = makeDirectory(childName, {});
            children.set(childName, created);
            return created;
          }
          throw new DOMException('Missing directory', 'NotFoundError');
        },
        async getFileHandle(childName: string, options?: { create?: boolean }) {
          const child = children.get(childName);
          if (child?.kind === 'file') return child;
          if (options?.create) {
           const created = makeFile(childName, '');
            if (name === 'fb-mae' && childName === 'bookmarks.json') {
              const persisted = makeFile(childName, '', '__e2eBookmarks');
              children.set(childName, persisted);
              return persisted;
            }
            children.set(childName, created);
            return created;
          }
          throw new DOMException('Missing file', 'NotFoundError');
        },
        async removeEntry(childName: string) {
          if (childName === 'blocked.jpg' && failBlockedMedia) {
            failBlockedMedia = false;
            throw new DOMException('Injected media removal failure', 'NotAllowedError');
          }
          if (!children.delete(childName)) throw new DOMException('Missing entry', 'NotFoundError');
        },
        async queryPermission() { return 'granted' as PermissionState; },
        async requestPermission() { return 'granted' as PermissionState; },
        async *entries() {
          for (const entry of children.entries()) yield entry;
        },
      };
    };

    const savedBookmarks = sessionStorage.getItem('__e2eBookmarks');
    const facebook = makeDirectory('messages', {
      inbox: makeDirectory('inbox', {
        alice_chat: makeDirectory('alice_chat', {
          'message_1.json': makeFile('message_1.json', JSON.stringify({
            title: 'Alice Chat',
            thread_path: 'inbox/alice_chat',
            participants: [{ name: 'Alice' }, { name: 'Tester' }],
            messages: [
              ...(includeBumpedMessages ? [
                { sender_name: 'Tester', timestamp_ms: 70,
                  bumped_message_metadata: { is_bumped: true, bumped_message: '' } },
                { sender_name: 'Tester', timestamp_ms: 60, content: 'Repeated bump body',
                  bumped_message_metadata: { is_bumped: true, bumped_message: 'Repeated bump body' } },
                { sender_name: 'Alice', timestamp_ms: 50,
                  bumped_message_metadata: { is_bumped: true, bumped_message: 'Recovered bump quote\nSecond line https://example.com/bumped' } },
              ] : []),
              {
                sender_name: 'Alice', timestamp_ms: 20,
                content: selectedFormat === 'instagram' ? 'needle from Instagram' : 'needle from Facebook',
                photos: [{ uri: selectedFormat === 'instagram'
                  ? 'your_instagram_activity/messages/inbox/alice_chat/photos/photo.jpg'
                  : 'photos/photo.jpg' }],
              },
              { sender_name: 'Tester', timestamp_ms: 10, content: 'first message', share: { link: 'https://example.com/report', share_text: 'Shared report' } },
              ...(includeUnavailableMedia ? [{
                sender_name: 'Alice', timestamp_ms: 30,
                photos: [{ uri: 'photos/missing.jpg' }], videos: [{ uri: 'videos/grid.mp4' }],
                audio_files: [{ uri: 'audio/missing.ogg' }], files: [{ uri: 'files/missing.pdf' }],
                sticker: { uri: 'stickers/missing.webp' },
              }, {
                sender_name: 'Tester', timestamp_ms: 40,
                photos: [{ uri: 'photos/missing.jpg' }, { uri: 'photos/photo.jpg' }], videos: [{ uri: 'videos/grid.mp4' }],
                audio_files: [{ uri: 'audio/missing.ogg' }], files: [{ uri: 'files/missing.pdf' }],
                sticker: { uri: 'stickers/missing.webp' },
              }] : []),
            ],
          })),
          photos: makeDirectory('photos', { 'photo.jpg': makeFile('photo.jpg', [1, 2, 3]) }),
        }),
        bob_chat: makeDirectory('bob_chat', {
          'message_1.json': makeFile('message_1.json', JSON.stringify({
            title: 'Bob Chat',
            thread_path: 'inbox/bob_chat',
            participants: [{ name: 'Bob' }, { name: 'Tester' }],
            messages: [{ sender_name: 'Bob', timestamp_ms: 5, content: 'keep this chat' }],
          })),
        }),
      }),
      ...(savedBookmarks ? {
        'fb-mae': makeDirectory('fb-mae', {
          'bookmarks.json': makeFile('bookmarks.json', savedBookmarks, '__e2eBookmarks'),
        }),
      } : {}),
    });
    const instagram = makeDirectory('instagram-export', {
      your_instagram_activity: makeDirectory('your_instagram_activity', { messages: facebook }),
    });
    const messenger = makeDirectory('messenger', {
      'alice.json': makeFile('alice.json', JSON.stringify({
        threadName: 'Messenger Alice',
        participants: ['Alice', 'Tester'],
        messages: [
          { senderName: 'Tester', text: 'first Messenger message', timestamp: 10 },
          { senderName: 'Alice', text: 'needle from Messenger', timestamp: 20, media: [
            { uri: 'media/photo.jpg' },
            { uri: 'media/blocked.jpg' },
            { uri: 'media/shared.jpg' },
          ] },
          ...(includeUnavailableMedia ? [
            { senderName: 'Alice', text: '', timestamp: 30, media: [{ uri: 'media/missing.jpg' }] },
            { senderName: 'Alice', text: '', timestamp: 40, media: [{ uri: 'Failed to download media' }, { uri: 'Failed to download media' }] },
            { senderName: 'Alice', text: '', timestamp: 50, media: [{ uri: 'media/missing.ogg' }, { uri: 'media/missing.pdf' }] },
            { senderName: 'Alice', text: '', timestamp: 60, media: [{ uri: 'media/grid.jpg' }, { uri: 'media/grid.mp4' }] },
            { senderName: 'Alice', text: '', timestamp: 70, media: [{ uri: 'media/dimensions.png' }] },
            { senderName: 'Tester', text: '', timestamp: 80, media: [
              { uri: 'media/missing.jpg' }, { uri: 'media/photo.jpg' }, { uri: 'media/grid.mp4' },
              { uri: 'media/missing.ogg' }, { uri: 'media/missing.pdf' },
            ] },
          ] : []),
        ],
      })),
      'group.json': makeFile('group.json', JSON.stringify({
        threadName: 'Messenger Group',
        participants: ['Alice', 'Tester', 'Bob'],
        messages: [{ senderName: 'Bob', text: 'keep this group', timestamp: 5, media: [{ uri: 'media/shared.jpg' }] }],
      })),
      media: makeDirectory('media', {
        'photo.jpg': makeFile('photo.jpg', [1, 2, 3]),
        'blocked.jpg': makeFile('blocked.jpg', [4, 5, 6]),
        'shared.jpg': makeFile('shared.jpg', [7, 8, 9]),
        ...(includeUnavailableMedia ? {
          // A readable 100 x 200 PNG header with no image data: sizing succeeds, decoding fails.
          'dimensions.png': makeFile('dimensions.png', [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 100, 0, 0, 0, 200]),
        } : {}),
      }),
    });

    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_deletionEnabled`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_attachmentBookmarkingEnabled`, '1');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => selectedFormat === 'facebook' ? facebook : selectedFormat === 'instagram' ? instagram : messenger,
    });
    Object.defineProperty(window, '__testArchives', { configurable: true, value: { facebook, messenger } });
  }, { selectedFormat: format, shouldFailMessengerMediaOnce: failMessengerMediaOnce, includeUnavailableMedia: unavailableMedia, includeBumpedMessages: bumpedMessages });
}

test('renders bumped messages and searches their recovered quotes', async ({ page }) => {
  await installArchive(page, 'facebook', false, false, true);
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(chat).toContainText('Bumped a message: Unknown');
  await chat.click();
  await expect(page.locator('#chat .msg-bump')).toHaveCount(3);
  await expect(page.locator('#chat .msg-bump').filter({ hasText: 'Bumped a message: Unknown' })).toHaveCount(1);
  await expect(page.locator('#chat .msg-bump').first()).toHaveCSS('font-style', 'italic');
  await expect(page.locator('#chat blockquote')).toHaveCount(2);
  await expect(page.locator('#chat').getByText('Repeated bump body', { exact: true })).toHaveCount(1);
  const quote = page.locator('#chat blockquote').filter({ hasText: 'Recovered bump quote' });
  await expect(quote).toContainText('Recovered bump quote\nSecond line');
  await expect(quote.getByRole('link')).toHaveAttribute('href', 'https://example.com/bumped');
  await expect(page.locator('#chat .msg-unavailable')).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('Recovered bump quote');
  await search.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('Recovered bump quote');
  await expect(quote.locator('.search-highlight')).toHaveText('Recovered bump quote');
});

test('wraps long viewer filenames and copies the original filename from options', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  const stem = 'a_very_long_original_attachment_filename_with_no_spaces_'.repeat(5);
  const filenames = [`${stem}missing.pdf`, `${stem}document.pdf`, `${stem}recording.wav`,
    `${stem}missing.jpg`, `${stem}missing.mp4`, `${stem}missing.gif`];
  await page.evaluate(async names => {
    const root = (window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } }).__testArchives.messenger;
    const conversation = await root.getFileHandle('alice.json');
    const writable = await conversation.createWritable();
    await writable.write(JSON.stringify({ threadName: 'Messenger Alice', participants: ['Alice', 'Tester'],
      messages: [{ senderName: 'Alice', timestamp: 10, media: names.map(name => ({ uri: `./media/${name}` })) }],
    }));
    await writable.close();
    const media = await root.getDirectoryHandle('media');
    const file = await media.getFileHandle(names[1], { create: true });
    const fileWriter = await file.createWritable();
    await fileWriter.write('A document');
    await fileWriter.close();
    // A short, silent PCM WAV lets the audio card render without a decode failure.
    const bytes = new Uint8Array(44 + 8000);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => Array.from(value).forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 8000, true);
    const audio = await media.getFileHandle(names[2], { create: true });
    const audioWriter = await audio.createWritable();
    await audioWriter.write(bytes);
    await audioWriter.close();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => sessionStorage.setItem('__copiedFilename', value),
    } });
  }, filenames);
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' }).click();
  await page.locator('#chat').getByRole('button', { name: 'Image not found or unreadable' }).first().click();
  const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
  // Typed visual media, audio, and GIFs are indexed before generic file attachments.
  const viewerFilenames = [filenames[3], filenames[4], filenames[2], filenames[5], filenames[0], filenames[1]];
  for (let i = 0; i < viewerFilenames.length; i++) {
    const name = viewer.locator('.media-viewer-file-name');
    await expect(name).toHaveText(viewerFilenames[i]);
    if (i === 2) await expect(viewer.locator('.media-viewer-audio')).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(name).toHaveCSS('white-space', 'normal');
      const layout = await name.evaluate(element => {
        const name = element as HTMLElement;
        const card = name.parentElement!;
        const bounds = name.getBoundingClientRect();
        return { height: bounds.height, lineHeight: parseFloat(getComputedStyle(name).lineHeight),
          left: bounds.left, right: bounds.right, width: name.clientWidth, scrollWidth: name.scrollWidth,
          cardWidth: card.clientWidth, cardScrollWidth: card.scrollWidth };
      });
      expect(layout.height).toBeGreaterThan(layout.lineHeight * 2);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardWidth + 1);
    }
    await viewer.getByRole('button', { name: 'More options' }).click();
    await expect(viewer.locator('.media-viewer-menu-item').last()).toHaveText('Copy filename');
    await viewer.getByRole('button', { name: 'Copy filename' }).click();
    await expect(viewer.getByRole('button', { name: 'Filename copied' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('__copiedFilename'))).toBe(viewerFilenames[i]);
    if (i < viewerFilenames.length - 1) await viewer.getByRole('button', { name: 'Next item' }).click();
  }
});

test('unavailable media retains slot geometry and shows failed counts in red', async ({ page }) => {
  await installArchive(page, 'messenger', false, true);
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' }).click();
  const chat = page.locator('#chat');
  const failed = chat.getByRole('img', { name: 'Failed to download media. Attachment type unknown.' });
  await expect(failed).toHaveCount(2);
  for (const placeholder of await failed.all()) {
    const bounds = await placeholder.boundingBox();
    expect(bounds?.width).toBe(150);
    expect(bounds?.height).toBe(110);
    await expect(placeholder.locator('svg')).toHaveAttribute('width', '24');
  }
  const singleImage = chat.locator('.message[data-msg-index="2"] .unavailable-attachment');
  await expect(singleImage).toBeVisible();
  expect((await singleImage.boundingBox())?.height).toBe(110);
  const audio = chat.locator('.message[data-msg-index="4"]').getByRole('button', { name: 'Audio not found or unreadable' });
  expect((await audio.boundingBox())?.height).toBe(34);
  const file = chat.locator('.message[data-msg-index="4"] .media-file-missing');
  expect((await file.boundingBox())?.height).toBe(54);
  const grid = chat.locator('.message[data-msg-index="5"] .message-media-grid');
  await expect(grid.locator('.unavailable-attachment')).toHaveCount(2);
  for (const cell of await grid.locator('.lazy-media-wrapper').all()) {
    const bounds = await cell.boundingBox();
    const iconSlot = await cell.locator('.unavailable-attachment').boundingBox();
    expect(bounds!.width).toBeCloseTo(bounds!.height, 0);
    expect(iconSlot!.height).toBeCloseTo(bounds!.height, 0);
  }
  const sizedImage = chat.locator('.message[data-msg-index="6"]');
  await expect(sizedImage.locator('.unavailable-attachment')).toBeVisible();
  expect((await sizedImage.locator('.media-preview-reserved').boundingBox())?.height).toBe(200);
  expect((await sizedImage.locator('.unavailable-attachment').boundingBox())?.height).toBe(200);
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  const failureRow = page.locator('.info-failed-media');
  await expect(failureRow).toBeVisible();
  await expect(failureRow.locator('.responsive-full')).toHaveText('2');
  await expect(failureRow.locator('span').first()).toHaveCSS('color', 'rgb(255, 138, 128)');
  await expect(failureRow.locator('.attachment-count')).toHaveCSS('color', 'rgb(255, 138, 128)');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await expect(failureRow.locator('span').first()).toHaveCSS('color', 'rgb(180, 35, 24)');
  await expect(failureRow.locator('.attachment-count')).toHaveCSS('color', 'rgb(180, 35, 24)');
  const mediaRow = failureRow.locator('xpath=preceding-sibling::div[1]');
  await expect(mediaRow).toContainText('Media files');
  await expect(mediaRow.locator('.responsive-full')).toHaveText(['4', '11']);
  // File presence, rather than successful decoding, is what the loaded count measures.
  await expect(chat.locator('.message[data-msg-index="1"] .unavailable-attachment')).toHaveCount(3);
  await expect(chat.locator('.message[data-msg-index="1"] .unavailable-attachment').first()).toBeVisible();
});

for (const format of ['facebook', 'instagram', 'messenger'] as const) {
  test(`opens missing attachments from ${format} chat with mouse and keyboard`, async ({ page }) => {
    await installArchive(page, format, false, true);
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: format === 'messenger' ? 'Messenger Alice' : 'Alice Chat' }).click();
    const chat = page.locator('#chat');
    const cases = [
      { target: chat.locator('.message[data-msg-index="2"]').getByRole('button', { name: 'Image not found or unreadable' }), filename: 'missing.jpg' },
      { target: chat.locator(`.message[data-msg-index="${format === 'messenger' ? 5 : 2}"]`).getByRole('button', { name: 'Video not found' }), filename: 'grid.mp4', key: 'Enter' },
      { target: chat.locator(`.message[data-msg-index="${format === 'messenger' ? 4 : 2}"]`).getByRole('button', { name: 'Audio not found or unreadable' }), filename: 'missing.ogg', key: ' ' },
      { target: chat.locator(`.message[data-msg-index="${format === 'messenger' ? 4 : 2}"]`).getByRole('button', { name: 'File not found: missing.pdf' }), filename: 'missing.pdf' },
      ...(format !== 'messenger' ? [{ target: chat.locator('.message[data-msg-index="2"]').getByRole('button', { name: 'Sticker not found or unreadable' }), filename: 'missing.webp' }] : []),
    ];
    for (const { target, filename, key } of cases) {
      await expect(target).toBeVisible();
      if (key) await target.press(key);
      else await target.click();
      const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText(filename);
      await expect(viewer).toContainText('File not found');
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
    }
  });

  test(`opens repeated attachments from ${format} chat at the clicked message`, async ({ page }) => {
    await installArchive(page, format, false, true);
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: format === 'messenger' ? 'Messenger Alice' : 'Alice Chat' }).click();
    const messageIndex = format === 'messenger' ? 7 : 3;
    const message = page.locator(`#chat .message[data-msg-index="${messageIndex}"]`);
    const cases = [
      { target: message.getByRole('button', { name: 'Image not found or unreadable' }).nth(0), filename: 'missing.jpg', missing: true },
      { target: message.getByRole('button', { name: 'Image not found or unreadable' }).nth(1), filename: 'photo.jpg', missing: false },
      { target: message.getByRole('button', { name: 'Video not found' }), filename: 'grid.mp4', missing: true },
      { target: message.getByRole('button', { name: 'Audio not found or unreadable' }), filename: 'missing.ogg', missing: true },
      { target: message.getByRole('button', { name: 'File not found: missing.pdf' }), filename: 'missing.pdf', missing: true },
      ...(format !== 'messenger' ? [{ target: message.getByRole('button', { name: 'Sticker not found or unreadable' }), filename: 'missing.webp', missing: true }] : []),
    ];
    for (const { target, filename, missing } of cases) {
      await target.click();
      const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText(filename);
      await expect(viewer.locator('.media-viewer-sender')).toHaveText('Tester');
      await expect(viewer).toContainText(missing ? 'File not found' : 'Attachment could not be displayed');
      await viewer.getByRole('button', { name: 'More options' }).click();
      await viewer.getByRole('button', { name: 'Jump to message' }).click();
      await expect(viewer).toHaveCount(0);
      await expect(message).toHaveClass(/highlight-target/);
    }
    // A jump from chat highlights that exact occurrence in the gallery.
    await cases[0].target.click();
    const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
    await viewer.getByRole('button', { name: 'More options' }).click();
    await viewer.getByRole('button', { name: 'Jump to attachment' }).click();
    await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();
    const reused = page.locator('.gallery-thumb[title="missing.jpg"]');
    await expect(reused).toHaveCount(2);
    await expect(reused.first()).toHaveClass(/jump-highlight/);
    await reused.first().click();
    await expect(viewer.locator('.media-viewer-sender')).toHaveText('Tester');
    await viewer.getByRole('button', { name: 'Close' }).click();
    await expect(reused.locator('.gallery-reuse-indicator')).toHaveText(['2', '2']);

    // Counts and selections refer to unique files, even with separate cards.
    await page.locator('.gallery-tab').filter({ hasText: 'Audio' }).click();
    await expect(page.locator('.gallery-tab.active .gallery-tab-count')).toHaveText('1');
    const audio = page.locator('.gallery-thumb[title="missing.ogg"]');
    await expect(audio).toHaveCount(2);
    await page.getByRole('button', { name: 'Select attachments and links' }).click();
    await audio.first().click();
    await expect(page.locator('.gallery-thumb[title="missing.ogg"].selected')).toHaveCount(2);
    await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
    await expect(page.locator('.selection-panel-header')).toContainText('1 Selected');
    await expect(page.locator('.selection-grid .gallery-thumb')).toHaveCount(1);
    await audio.last().click();
    await expect(page.locator('.gallery-thumb[title="missing.ogg"].selected')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select attachments and links' }).click();

    // Bookmarking either use marks both; filtering keeps both occurrences.
    await audio.first().click();
    await page.getByRole('button', { name: 'Bookmark item' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(audio.locator('.gallery-bookmark-indicator')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('__e2eBookmarks')!).bookmarks.length)).toBe(1);
    await page.getByRole('button', { name: 'Toggle attachment filters' }).click();
    await page.getByRole('button', { name: 'Bookmark filter: all' }).click();
    await expect(audio).toHaveCount(2);
    await expect(page.getByLabel('1 of 1 items shown')).toBeVisible();
    await page.getByRole('button', { name: 'Bookmark filter: bookmarked' }).click();
    await expect(page.getByText('No matching attachments')).toBeVisible();
    await page.getByRole('button', { name: 'Clear all attachment filters' }).click();
    await audio.last().click();
    await page.getByRole('button', { name: 'Remove bookmark' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(audio.locator('.gallery-bookmark-indicator')).toHaveCount(0);
  });
}

test('opens a Facebook archive and wires chat, search, gallery, and pinning', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.locator('.message-wrapper').getByText('needle from Facebook')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attachments', includeHidden: true })).toHaveCount(0);

  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('needle');
  await search.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('needle from Facebook');

  await chat.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Pin to top' }).click();
  await expect(chat.getByLabel('Pinned chat')).toBeVisible();

  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();
  await page.locator('.gallery-tab').filter({ hasText: 'Links' }).click();
  await expect(page.locator('.gallery-tab.active')).toContainText('Links');
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(page.getByRole('heading', { name: 'Attachments', includeHidden: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.locator('.gallery-tab.active')).toContainText('Links');
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' }).click();
  await expect(page.locator('.message-wrapper').getByText('keep this chat')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attachments', includeHidden: true })).toHaveCount(0);
});

test('opens an Instagram export root and searches its conversation', async ({ page }) => {
  await installArchive(page, 'instagram');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.locator('.message-wrapper').getByText('needle from Instagram')).toBeVisible();
  await expect(page.locator('.message-wrapper')).toHaveCount(2);

  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('needle');
  await search.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('needle from Instagram');

  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();
});

test('opens and cancels the destructive Facebook deletion confirmation', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(chat).toBeVisible();
  await chat.hover();
  await chat.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await expect(page.getByRole('dialog')).toContainText('Delete');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(chat).toBeVisible();
});

test('opens a standalone Messenger export and searches its normalized conversation', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.locator('.message-wrapper').getByText('needle from Messenger')).toBeVisible();
  await expect(page.locator('.message-wrapper')).toHaveCount(2);

  const search = page.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('needle');
  await search.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText('needle from Messenger');
});

test('deletes a Facebook chat and keeps its sibling conversation', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(alice).toBeVisible();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Pin to top' }).click();
  await expect(alice.getByLabel('Pinned chat')).toBeVisible();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  const confirm = page.getByRole('button', { name: 'Delete permanently' });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(alice).toHaveCount(0);
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = sessionStorage.getItem('__e2eBookmarks');
    return saved ? JSON.parse(saved).pinnedChats.length : -1;
  })).toBe(0);
  await expect.poll(() => page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const inbox = await root.getDirectoryHandle('inbox');
    try { await inbox.getDirectoryHandle('alice_chat'); return true; } catch { return false; }
  })).toBe(false);
});

test('deletes Messenger JSON and exclusive media but preserves shared data', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await expect(alice).toBeVisible();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  const confirm = page.getByRole('button', { name: 'Delete permanently' });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(alice).toHaveCount(0);
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Messenger Group' })).toBeVisible();
  const remaining = await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } }).__testArchives.messenger;
    const media = await root.getDirectoryHandle('media');
    const exists = async (directory: FileSystemDirectoryHandle, name: string) => {
      try { await directory.getFileHandle(name); return true; } catch { return false; }
    };
    return {
      aliceJson: await exists(root, 'alice.json'),
      groupJson: await exists(root, 'group.json'),
      photo: await exists(media, 'photo.jpg'),
      blocked: await exists(media, 'blocked.jpg'),
      shared: await exists(media, 'shared.jpg'),
    };
  });
  expect(remaining).toEqual({ aliceJson: false, groupJson: true, photo: false, blocked: false, shared: true });
});

test('stacks cross-chat attachment counts above local usage and updates after deletion', async ({ page }) => {
  await installArchive(page, 'messenger');
  await page.goto('');
  await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } }).__testArchives.messenger;
    for (const name of ['alice.json', 'group.json']) {
      const file = await root.getFileHandle(name);
      const raw = JSON.parse(await (await file.getFile()).text());
      if (name === 'alice.json') raw.messages[0].media = [{ uri: 'media/photo.jpg' }];
      else raw.messages[0].media.push({ uri: 'media/photo.jpg' });
      const writable = await file.createWritable();
      await writable.write(JSON.stringify(raw));
      await writable.close();
    }
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await alice.click();
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const thumbnail = page.locator('.gallery-thumb[title="photo.jpg"]').first();
  const crossChat = thumbnail.getByLabel('Attachment used in 2 chats');
  const local = thumbnail.getByLabel('Attachment used 2 times in this chat');
  await expect(crossChat).toBeVisible();
  await expect(local).toBeVisible();
  const crossBounds = await crossChat.boundingBox();
  const localBounds = await local.boundingBox();
  expect(crossBounds!.y + crossBounds!.height).toBeLessThan(localBounds!.y);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(alice).toHaveCount(0);
  await page.locator('.chat-list-item').filter({ hasText: 'Messenger Group' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.locator('.gallery-thumb[title="photo.jpg"]')).toBeVisible();
  await expect(page.getByLabel('Attachment used in 2 chats')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { messenger: FileSystemDirectoryHandle } }).__testArchives.messenger;
    return (await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg')).kind;
  })).toBe('file');
});

for (const format of ['facebook', 'messenger'] as const) {
test(`connects ${format} ownership scanning and gallery counts to the deletion setting`, async ({ page }) => {
  await installArchive(page, format);
  await page.addInitScript(() => {
    localStorage.setItem(`majv_${location.hostname}_setting_deletionEnabled`, '0');
    const BaseWorker = window.Worker;
    Object.defineProperty(window, '__ownershipWorkerCount', { configurable: true, writable: true, value: 0 });
    window.Worker = class extends BaseWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('metaAttachmentWorker')) (window as unknown as { __ownershipWorkerCount: number }).__ownershipWorkerCount++;
      }
    };
  });
  await page.goto('');
  await page.evaluate(async selectedFormat => {
    const roots = (window as unknown as { __testArchives: Record<string, FileSystemDirectoryHandle> }).__testArchives;
    const root = roots[selectedFormat];
    const inbox = selectedFormat === 'facebook' ? await root.getDirectoryHandle('inbox') : null;
    const a = inbox ? await (await inbox.getDirectoryHandle('alice_chat')).getFileHandle('message_1.json') : await root.getFileHandle('alice.json');
    const b = inbox ? await (await inbox.getDirectoryHandle('bob_chat')).getFileHandle('message_1.json') : await root.getFileHandle('group.json');
    const uri = inbox ? 'messages/inbox/alice_chat/photos/photo.jpg' : 'media/photo.jpg';
    const first = JSON.parse(await (await a.getFile()).text());
    const second = JSON.parse(await (await b.getFile()).text());
    const field = inbox ? 'photos' : 'media';
    first.messages[0][field] = [{ uri }];
    first.messages[1][field] = [{ uri }];
    second.messages[0][field] = [{ uri }];
    for (const [handle, raw] of [[a, first], [b, second]] as const) {
      const writer = await handle.createWritable(); await writer.write(JSON.stringify(raw)); await writer.close();
    }
    const read = b.getFile.bind(b);
    Object.defineProperty(window, '__sharedJsonReadCount', { configurable: true, writable: true, value: 0 });
    b.getFile = async () => {
      (window as unknown as { __sharedJsonReadCount: number }).__sharedJsonReadCount++;
      return read();
    };
  }, format);
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: format === 'facebook' ? 'Alice Chat' : 'Messenger Alice' }).click();
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const thumb = page.locator('.gallery-thumb[title="photo.jpg"]').first();
  await expect(thumb).toBeVisible();
  await expect(thumb.getByLabel('Attachment used 2 times in this chat')).toBeVisible();
  await expect(page.getByLabel('Attachment used in 2 chats')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Shared attachment scan', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __ownershipWorkerCount: number }).__ownershipWorkerCount)).toBe(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const toggle = page.locator('label[for="deletionEnabledToggle"]');
  await toggle.click(); await page.getByRole('button', { name: 'I understand, enable deletion' }).click();
  await expect(thumb.getByLabel('Attachment used in 2 chats')).toBeVisible();
  const reads = await page.evaluate(() => (window as unknown as { __sharedJsonReadCount: number }).__sharedJsonReadCount);
  await toggle.click();
  await expect(page.getByLabel('Attachment used in 2 chats')).toHaveCount(0);
  await expect(page.locator('.gallery-reference-status')).toHaveCount(0);
  await expect(thumb.getByLabel('Attachment used 2 times in this chat')).toBeVisible();
  await toggle.click(); await page.getByRole('button', { name: 'I understand, enable deletion' }).click();
  await expect(thumb.getByLabel('Attachment used in 2 chats')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sharedJsonReadCount: number }).__sharedJsonReadCount)).toBeGreaterThan(reads);
  if (format === 'facebook') expect(await page.evaluate(() => (window as unknown as { __ownershipWorkerCount: number }).__ownershipWorkerCount)).toBe(2);
});
}

test('previews and safely removes Facebook shared stickers after their last chat is deleted', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const stickers = await root.getDirectoryHandle('stickers_used', { create: true });
    const file = await stickers.getFileHandle('shared.webp', { create: true });
    const writable = await file.createWritable();
    await writable.write(new Uint8Array([1, 2, 3])); await writable.close();
    const inbox = await root.getDirectoryHandle('inbox');
    for (const name of ['alice_chat', 'bob_chat']) {
      const json = await (await inbox.getDirectoryHandle(name)).getFileHandle('message_1.json');
      const raw = JSON.parse(await (await json.getFile()).text());
      raw.messages[0].sticker = { uri: 'your_facebook_activity/messages/stickers_used/shared.webp' };
      if (name === 'bob_chat') raw.messages.push({ sender_name: 'Bob', timestamp_ms: 6, sticker: { uri: 'https://example.com/remote-sticker.png' } });
      const stream = await json.createWritable();
      await stream.write(JSON.stringify(raw)); await stream.close();
    }
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await alice.click();
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.locator('.gallery-thumb[title="shared.webp"]').getByLabel('Attachment used in 2 chats')).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat' }).click();
  for (const title of ['Alice Chat', 'Bob Chat']) {
    const target = page.locator('.chat-list-item').filter({ hasText: title });
    await target.hover();
    await target.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'Delete chat' }).click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
    await expect(dialog.getByText('Shared stickers:')).toBeVisible();
    await expect(dialog.getByText('Recoverable:')).toBeVisible();
    await expect(dialog.getByText(title === 'Alice Chat' ? '0 B (0 files)' : '3 B (1 files)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(target).toHaveCount(0);
    const stickerExists = await page.evaluate(async () => {
      const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
      try { await (await root.getDirectoryHandle('stickers_used')).getFileHandle('shared.webp'); return true; }
      catch { return false; }
    });
    expect(stickerExists).toBe(title === 'Alice Chat');
  }
});

for (const format of ['facebook', 'instagram'] as const) {
test(`loads cross-folder ${format} images in the referencing chat and gallery`, async ({ page }) => {
  await installArchive(page, format);
  await page.goto('');
  await page.evaluate(async selectedFormat => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const inbox = await root.getDirectoryHandle('inbox');
    for (const [name, color] of [['alice_chat', 'red'], ['bob_chat', 'blue']]) {
      const photos = await (await inbox.getDirectoryHandle(name)).getDirectoryHandle('photos', { create: true });
      const file = await photos.getFileHandle('shared.png', { create: true });
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
      const writer = await file.createWritable(); await writer.write(new Uint8Array(await blob.arrayBuffer())); await writer.close();
      const json = await (await inbox.getDirectoryHandle(name)).getFileHandle('message_1.json');
      const raw = JSON.parse(await (await json.getFile()).text());
      const activity = selectedFormat === 'facebook' ? 'your_facebook_activity' : 'your_instagram_activity';
      raw.messages[0].photos = [{ uri: `${activity}/messages/inbox/alice_chat/photos/shared.png` }];
      const stream = await json.createWritable(); await stream.write(JSON.stringify(raw)); await stream.close();
    }
  }, format);
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' }).click();
  const preview = page.locator('#chat img').first();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // Decode the preview pixel, proving that the foreign red image was loaded
  // instead of Bob's same-named blue local file.
  const pixel = await preview.evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  });
  // Chat previews can use lossy image encoding; a red pixel can pick up a
  // small green/blue component without becoming Bob's blue image.
  expect(pixel[0]).toBeGreaterThan(240);
  expect(pixel[1]).toBeLessThan(10);
  expect(pixel[2]).toBeLessThan(10);
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const shared = page.locator('.gallery-thumb[title="shared.png"]').filter({ has: page.getByLabel('Attachment used in 2 chats') });
  await expect(shared).toBeVisible();
  await expect.poll(() => shared.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
}

test('shows fresh ownership verification inside the deletion dialog before removing chats', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await alice.hover(); await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Chat', exact: true });
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[] = []) {
        if ((message as { type?: string }).type === 'file') void gate.then(() => super.postMessage(message, transfer));
        else super.postMessage(message, transfer);
      }
    };
    Object.defineProperty(window, '__releaseDeletionVerification', { value: release });
  });
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  const verification = dialog.getByRole('status', { name: 'Deletion attachment verification' });
  await expect(verification).toContainText('Scanning for shared attachments');
  await expect(verification).toContainText('Folders/Subfolders Checked');
  await expect(verification).toContainText('JSON Found');
  await expect(alice).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Deleting...' })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __releaseDeletionVerification: () => void }).__releaseDeletionVerification());
  await expect(alice).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

test('shows gallery shared-video counts after scanning and blocks deleting their source chat', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const inbox = await root.getDirectoryHandle('inbox');
    const alice = await inbox.getDirectoryHandle('alice_chat');
    const videos = await alice.getDirectoryHandle('videos', { create: true });
    const video = await videos.getFileHandle('shared.mp4', { create: true });
    const stream = await video.createWritable(); await stream.write(new Uint8Array([1, 2, 3])); await stream.close();
    for (const name of ['alice_chat', 'bob_chat']) {
      const file = await (await inbox.getDirectoryHandle(name)).getFileHandle('message_1.json');
      const raw = JSON.parse(await (await file.getFile()).text());
      raw.messages[0].videos = [{ uri: 'your_facebook_activity/messages/inbox/alice_chat/videos/shared.mp4' }];
      const writable = await file.createWritable(); await writable.write(JSON.stringify(raw)); await writable.close();
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let released = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[] = []) {
        const request = message as { type?: string; chatId?: string };
        if (!released && request.type === 'file' && request.chatId === 'inbox/bob_chat') {
          void gate.then(() => super.postMessage(message, transfer));
        } else super.postMessage(message, transfer);
      }
    };
    Object.defineProperty(window, '__releaseReferenceScan', { value: () => { released = true; release(); } });
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  const scanStatus = page.getByRole('status', { name: 'Shared attachment scan' });
  await expect(scanStatus).toContainText('Scanning for shared attachments');
  await expect(scanStatus).toContainText('Folders/Subfolders Checked');
  await expect(scanStatus).toContainText('JSON Found');
  await expect(scanStatus).not.toContainText('entries');
  await expect(scanStatus.getByRole('progressbar')).toHaveCount(0);
  await alice.click();
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.locator('.gallery-reference-status')).toContainText('Scanning for shared attachments');
  await expect(page.getByLabel('Attachment used in 2 chats')).toHaveCount(0);
  expect(await scanStatus.evaluate(element => {
    const list = element.parentElement!.querySelector('.chat-list')!;
    return element.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1
      && element.getBoundingClientRect().bottom <= window.innerHeight;
  })).toBe(true);
  await page.evaluate(() => (window as unknown as { __releaseReferenceScan: () => void }).__releaseReferenceScan());
  await expect(page.locator('.gallery-thumb[title="shared.mp4"]').getByLabel('Attachment used in 2 chats')).toBeVisible();
  await expect(page.locator('.gallery-reference-status')).toHaveCount(0);
  await expect(scanStatus).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await expect(page.getByRole('button', { name: 'Deletion blocked' })).toBeDisabled();
  await expect(page.getByRole('list', { name: 'Chats depending on Alice Chat' })).toContainText('Bob Chat');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(alice).toBeVisible();
  const bob = page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' });
  await bob.hover();
  await bob.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(bob).toHaveCount(0);
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.locator('.gallery-thumb[title="shared.mp4"]')).toBeVisible();
  await expect(page.getByLabel('Attachment used in 2 chats')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(alice).toHaveCount(0);
});

for (const skipOwnership of [false, true]) {
test(skipOwnership ? 'calculates sizes after skipping the shared check while dependency detection stays pending'
  : 'keeps dependency detection before sizes and explicitly overrides folder protection', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const inbox = await root.getDirectoryHandle('inbox');
    const alice = await inbox.getDirectoryHandle('alice_chat');
    const video = await (await alice.getDirectoryHandle('videos', { create: true })).getFileHandle('shared.mp4', { create: true });
    const videoWriter = await video.createWritable(); await videoWriter.write(new Uint8Array([1, 2, 3])); await videoWriter.close();
    const stickers = await root.getDirectoryHandle('stickers_used', { create: true });
    const sticker = await stickers.getFileHandle('shared.png', { create: true });
    const stickerWriter = await sticker.createWritable(); await stickerWriter.write(new Uint8Array([4, 5])); await stickerWriter.close();
    for (const name of ['alice_chat', 'bob_chat']) {
      const file = await (await inbox.getDirectoryHandle(name)).getFileHandle('message_1.json');
      const raw = JSON.parse(await (await file.getFile()).text());
      raw.messages[0].videos = [{ uri: 'messages/inbox/alice_chat/videos/shared.mp4' }];
      raw.messages[0].sticker = { uri: 'messages/stickers_used/shared.png' };
      const writer = await file.createWritable(); await writer.write(JSON.stringify(raw)); await writer.close();
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let released = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[] = []) {
        const request = message as { type?: string; chatId?: string };
        if (!released && request.type === 'file' && request.chatId === 'inbox/bob_chat') {
          void gate.then(() => super.postMessage(message, transfer));
        } else super.postMessage(message, transfer);
      }
    };
    Object.defineProperty(window, '__releaseReferenceScan', { value: () => { released = true; release(); } });
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.evaluate(() => {
    const positions: Array<{ label: string; offset: number }> = [];
    Object.defineProperty(window, '__deleteActionPositions', { value: positions });
    new MutationObserver(() => {
      for (const action of document.querySelectorAll<HTMLElement>('.delete-preparation-actions button')) {
        const footer = action.closest('.delete-actions')!;
        positions.push({ label: action.textContent || '', offset: action.getBoundingClientRect().left - footer.getBoundingClientRect().left });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Delete chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Chat', exact: true });
  const skipCheck = dialog.getByRole('button', { name: 'Skip check' });
  await expect(skipCheck).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Skip calculation' })).toHaveCount(0);
  await expect(dialog.getByRole('status', { name: 'Deletion calculation progress' })).toContainText('Scanning for shared attachments');
  await expect(dialog.getByRole('button', { name: 'Preparing...', exact: true })).toBeDisabled();
  const skipPosition = await skipCheck.evaluate(button => ({
    left: button.getBoundingClientRect().left,
    footerLeft: button.closest('.delete-actions')!.getBoundingClientRect().left,
  }));
  expect(skipPosition.left).toBeCloseTo(skipPosition.footerLeft, 0);
  await expect(dialog.getByRole('button', { name: 'Delete anyway' })).toHaveCount(0);
  if (skipOwnership) {
    // Delay a size-only media read, independently of the held ownership worker.
    await page.evaluate(async () => {
      const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
      const photo = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat')).getDirectoryHandle('photos');
      const file = await photo.getFileHandle('photo.jpg');
      const read = file.getFile.bind(file);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      file.getFile = async () => { await gate; return read(); };
      Object.defineProperty(window, '__releaseSizeCalculation', { value: release });
    });
    await skipCheck.click();
    const sizeProgress = dialog.getByRole('status', { name: 'Deletion calculation progress' });
    await expect(sizeProgress).toContainText('Calculating chat sizes');
    await expect(sizeProgress).not.toContainText('Folders/Subfolders Checked');
    await expect(sizeProgress).not.toContainText('Scanning for shared attachments');
    await expect(page.getByRole('status', { name: 'Shared attachment scan' })).toContainText('Folders/Subfolders Checked');
    await expect(dialog.getByRole('button', { name: 'Skip check' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Calculating sizes...' })).toBeDisabled();
    await expect.poll(() => dialog.locator('.delete-card-body').evaluate(body => body.scrollHeight - body.clientHeight)).toBeLessThanOrEqual(1);
    await dialog.getByRole('button', { name: 'Skip calculation' }).click();
    await page.evaluate(() => (window as unknown as { __releaseSizeCalculation: () => void }).__releaseSizeCalculation());
    await expect(sizeProgress).toHaveCount(0);
    await expect.poll(() => dialog.locator('.delete-card-body').evaluate(body => body.scrollHeight - body.clientHeight)).toBeLessThanOrEqual(1);
    await expect(dialog.getByRole('alert')).toContainText('without checking dependencies');
    await expect(alice).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    // Do not release the pending read until deletion finishes: this proves
    // Skip check does not merely postpone the same blocking safety scan.
    await expect(alice).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __releaseReferenceScan: () => void }).__releaseReferenceScan());
  } else {
  await page.evaluate(() => (window as unknown as { __releaseReferenceScan: () => void }).__releaseReferenceScan());
  await expect(dialog.getByRole('list', { name: 'Chats depending on Alice Chat' })).toContainText('Bob Chat');
  await expect(dialog.getByRole('button', { name: 'Skip check' })).toHaveCount(0);
  await expect(dialog.getByText('inbox/bob_chat', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Deletion blocked' })).toBeDisabled();
  const override = dialog.getByRole('button', { name: 'Delete anyway' });
  await expect(override).toHaveAccessibleDescription(/Other chats may lose attachments/);
  const positions = await dialog.evaluate(element => ({
    override: element.querySelector('.delete-override-action')!.getBoundingClientRect().left,
    cancel: [...element.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.getBoundingClientRect().left,
  }));
  expect(positions.override).toBeLessThan(positions.cancel);
  await override.click();
  await expect(alice).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  }
  await expect(alice).toHaveCount(0);
  const positions = await page.evaluate(() => (window as unknown as { __deleteActionPositions: Array<{ label: string; offset: number }> }).__deleteActionPositions);
  if (skipOwnership) expect(positions.some(position => position.label === 'Skip calculation')).toBe(true);
  expect(positions.some(position => position.label === 'Skip check')).toBe(true);
  if (!skipOwnership) expect(positions.some(position => position.label === 'Delete anyway')).toBe(true);
  expect(positions.every(position => Math.abs(position.offset) < 1)).toBe(true);
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    await (await root.getDirectoryHandle('stickers_used')).getFileHandle('shared.png');
    await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('bob_chat')).getFileHandle('message_1.json');
    try { await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice_chat'); return false; }
    catch { return true; }
  })).toBe(true);
});
}

test('contains batch dependencies in a scrollable list grouped by protected chat', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.evaluate(async () => {
    const root = (window as unknown as { __testArchives: { facebook: FileSystemDirectoryHandle } }).__testArchives.facebook;
    const inbox = await root.getDirectoryHandle('inbox');
    for (const name of ['alice_chat', 'bob_chat']) {
      const directory = await inbox.getDirectoryHandle(name);
      const file = await (await directory.getDirectoryHandle('videos', { create: true })).getFileHandle('shared.mp4', { create: true });
      const writer = await file.createWritable(); await writer.write(new Uint8Array([1])); await writer.close();
    }
    for (let i = 0; i < 8; i++) {
      const directory = await inbox.getDirectoryHandle(`retained_${i}`, { create: true });
      const file = await directory.getFileHandle('message_1.json', { create: true });
      const raw = { title: `Retained Chat ${i}`, participants: [{ name: 'Tester' }], messages: [{ sender_name: 'Tester', timestamp_ms: i,
        videos: ['alice_chat', 'bob_chat'].map(name => ({ uri: `messages/inbox/${name}/videos/shared.mp4` })) }] };
      const writer = await file.createWritable(); await writer.write(JSON.stringify(raw)); await writer.close();
    }
  });
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await expect(page.locator('.chat-list-item')).toHaveCount(10);
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Select chats' }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Bob Chat' }).click();
  await page.locator('.sidebar-action-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete 2 Chats' });
  const dependencies = dialog.getByRole('region', { name: 'Protected chats and their dependencies' });
  await expect(dependencies.getByRole('list', { name: 'Chats depending on Alice Chat' }).getByRole('listitem')).toHaveCount(8);
  await expect(dependencies.getByRole('list', { name: 'Chats depending on Bob Chat' }).getByRole('listitem')).toHaveCount(8);
  await expect(dependencies.getByText('Retained Chat 7', { exact: true })).toHaveCount(2);
  expect(await dependencies.evaluate(element => ({
    scrolls: element.scrollHeight > element.clientHeight,
    height: element.getBoundingClientRect().height,
    overflow: getComputedStyle(element).overflowY,
  }))).toMatchObject({ scrolls: true, overflow: 'auto' });
  expect(await dependencies.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(202);
  await expect(dialog.getByRole('button', { name: 'Delete anyway' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page.screenshot({ path: '.plans/previews/delete-dependencies-batch.png' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.chat-list-item')).toHaveCount(10);
});

test('keeps a partial Messenger deletion retryable and completes it on retry', async ({ page }) => {
  await installArchive(page, 'messenger', true);
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Messenger Alice' });
  await alice.hover();
  await alice.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();

  await expect(page.getByRole('alert')).toContainText('Chat JSON remains');
  await expect(alice).toBeVisible();
  await page.getByRole('button', { name: 'Retry deletion' }).click();

  await expect(alice).toHaveCount(0);
  await expect(page.locator('.chat-list-item').filter({ hasText: 'Messenger Group' })).toBeVisible();
});

test('persists attachment and shared-link bookmarks and filters the gallery', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const alice = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await alice.click();
  await page.getByRole('button', { name: 'Toggle chat info panel' }).click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();

  await page.locator('.gallery-thumb[title="photo.jpg"]').click();
  await page.getByRole('button', { name: 'Bookmark item' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.gallery-tab').filter({ hasText: 'Links' }).click();
  await page.getByRole('button', { name: 'View information for example.com' }).click();
  await page.getByRole('button', { name: 'Bookmark item' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByLabel('Bookmarked link')).toBeVisible();

  await page.getByRole('button', { name: 'Toggle attachment filters' }).click();
  await page.getByRole('button', { name: 'Bookmark filter: all' }).click();
  await expect(page.getByRole('button', { name: 'Bookmark filter: bookmarked' })).toBeVisible();
  await expect(page.getByLabel('1 of 1 items shown')).toBeVisible();
  const filterSearch = page.getByRole('combobox', { name: /Search links or filenames/ });
  await filterSearch.fill('+Tester');
  await filterSearch.press('ArrowDown');
  await filterSearch.press('Enter');
  await expect(page.getByRole('button', { name: /Remove included sender filter for Tester/ })).toBeVisible();
  await page.locator('.gallery-tab').filter({ hasText: 'Photos' }).click();
  await expect(page.getByText('No matching attachments')).toBeVisible();
  await page.getByRole('button', { name: 'Clear all attachment filters' }).click();
  await expect(page.locator('.gallery-thumb[title="photo.jpg"]')).toBeVisible();
  await page.getByRole('button', { name: 'Select attachments and links' }).click();
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.getByRole('button', { name: 'Unselect all' })).toBeVisible();
  await page.getByRole('button', { name: 'Unselect all' }).click();
  await expect(page.getByRole('button', { name: 'Select all' })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  const infoToggle = page.getByRole('button', { name: 'Toggle chat info panel' });
  if (await infoToggle.getAttribute('aria-expanded') !== 'true') await infoToggle.click();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await expect(page.getByLabel('Bookmarked attachment')).toBeVisible();
  await page.locator('.gallery-tab').filter({ hasText: 'Links' }).click();
  await expect(page.getByLabel('Bookmarked link')).toBeVisible();
});
