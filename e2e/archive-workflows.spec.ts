import { expect, test, type Page } from '@playwright/test';

async function installArchive(page: Page, format: 'facebook' | 'messenger', failMessengerMediaOnce = false) {
  await page.addInitScript(({ selectedFormat, shouldFailMessengerMediaOnce }) => {
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
              { sender_name: 'Alice', timestamp_ms: 20, content: 'needle from Facebook', photos: [{ uri: 'photos/photo.jpg' }] },
              { sender_name: 'Tester', timestamp_ms: 10, content: 'first message', share: { link: 'https://example.com/report', share_text: 'Shared report' } },
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
      }),
    });

    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_deletionEnabled`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_attachmentBookmarkingEnabled`, '1');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => selectedFormat === 'facebook' ? facebook : messenger,
    });
    Object.defineProperty(window, '__testArchives', { configurable: true, value: { facebook, messenger } });
  }, { selectedFormat: format, shouldFailMessengerMediaOnce: failMessengerMediaOnce });
}

test('opens a Facebook archive and wires chat, search, gallery, and pinning', async ({ page }) => {
  await installArchive(page, 'facebook');
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  const chat = page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' });
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.getByText('needle from Facebook')).toBeVisible();

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
  await page.getByRole('button', { name: 'Back to chat' }).click();
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
  await expect(page.getByText('needle from Messenger')).toBeVisible();
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
