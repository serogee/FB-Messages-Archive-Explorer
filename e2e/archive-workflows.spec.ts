import { expect, test, type Page } from '@playwright/test';

async function installArchive(page: Page, format: 'facebook' | 'messenger') {
  await page.addInitScript(({ selectedFormat }) => {
    const makeFile = (name: string, contents: string | number[]) => ({
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
        return { async write() {}, async close() {} };
      },
    });
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
            children.set(childName, created);
            return created;
          }
          throw new DOMException('Missing file', 'NotFoundError');
        },
        async removeEntry(childName: string) {
          if (!children.delete(childName)) throw new DOMException('Missing entry', 'NotFoundError');
        },
        async *entries() {
          for (const entry of children.entries()) yield entry;
        },
      };
    };

    const facebook = makeDirectory('messages', {
      inbox: makeDirectory('inbox', {
        alice_chat: makeDirectory('alice_chat', {
          'message_1.json': makeFile('message_1.json', JSON.stringify({
            title: 'Alice Chat',
            thread_path: 'inbox/alice_chat',
            participants: [{ name: 'Alice' }, { name: 'Tester' }],
            messages: [
              { sender_name: 'Alice', timestamp_ms: 20, content: 'needle from Facebook', photos: [{ uri: 'photos/photo.jpg' }] },
              { sender_name: 'Tester', timestamp_ms: 10, content: 'first message' },
            ],
          })),
          photos: makeDirectory('photos', { 'photo.jpg': makeFile('photo.jpg', [1, 2, 3]) }),
        }),
      }),
    });
    const messenger = makeDirectory('messenger', {
      'alice.json': makeFile('alice.json', JSON.stringify({
        threadName: 'Messenger Alice',
        participants: ['Alice', 'Tester'],
        messages: [
          { senderName: 'Tester', text: 'first Messenger message', timestamp: 10 },
          { senderName: 'Alice', text: 'needle from Messenger', timestamp: 20, media: [{ uri: 'media/photo.jpg' }] },
        ],
      })),
      media: makeDirectory('media', { 'photo.jpg': makeFile('photo.jpg', [1, 2, 3]) }),
    });

    localStorage.setItem(`majv_${location.hostname}_setting_dontShowTrustModal`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_deletionEnabled`, '1');
    localStorage.setItem(`majv_${location.hostname}_setting_attachmentBookmarkingEnabled`, '1');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => selectedFormat === 'facebook' ? facebook : messenger,
    });
  }, { selectedFormat: format });
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
