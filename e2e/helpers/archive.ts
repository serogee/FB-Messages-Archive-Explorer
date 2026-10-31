import type { Page } from '@playwright/test';

export async function installArchive(page: Page, format: 'facebook' | 'instagram' | 'messenger', failMessengerMediaOnce = false, unavailableMedia = false, bumpedMessages = false, longMessages = 0, folderUpload = false, folderUploadPrefix = '', flattenFolderUpload = false) {
  await page.addInitScript(({ selectedFormat, shouldFailMessengerMediaOnce, includeUnavailableMedia, includeBumpedMessages, longMessageCount, useFolderUpload, uploadPrefix, flattenUpload }) => {
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
              ...Array.from({ length: longMessageCount }, (_, index) => ({
                sender_name: index % 2 ? 'Tester' : 'Alice', timestamp_ms: 1700000000000 + index * 86400000,
                content: `History message ${index} with enough text to exercise mobile message layout and scrolling.`,
                ...(index % 5 === 0 ? { photos: [{ uri: 'photos/photo.jpg' }] } : {}),
              })),
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
    // Workflow/layout fixtures do not exercise service worker notifications.
    localStorage.setItem(`majv_${location.hostname}_setting_offlineSupportEnabled`, '0');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => selectedFormat === 'facebook' ? facebook : selectedFormat === 'instagram' ? instagram : messenger,
    });
    if (useFolderUpload) {
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file' || !this.webkitdirectory) { originalClick.call(this); return; }
        const root = selectedFormat === 'facebook' ? facebook : selectedFormat === 'instagram' ? instagram : messenger;
        void (async (input: HTMLInputElement) => {
          const files: File[] = [];
          async function collect(directory: ReturnType<typeof makeDirectory>, prefix: string) {
            for await (const [name, entry] of directory.entries()) {
              const path = `${prefix}/${name}`;
              if (entry.kind === 'directory') await collect(entry, path);
              else {
                const file = await entry.getFile();
                Object.defineProperty(file, 'webkitRelativePath', { value: flattenUpload ? `${uploadPrefix ? uploadPrefix + '/' : ''}${root.name}/${file.name}` : path });
                files.push(file);
              }
            }
          }
          await collect(root, uploadPrefix ? `${uploadPrefix}/${root.name}` : root.name);
          Object.defineProperty(input, 'files', { configurable: true, value: files });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })(this);
      };
    }
    Object.defineProperty(window, '__testArchives', { configurable: true, value: { facebook, messenger } });
  }, { selectedFormat: format, shouldFailMessengerMediaOnce: failMessengerMediaOnce, includeUnavailableMedia: unavailableMedia, includeBumpedMessages: bumpedMessages, longMessageCount: longMessages, useFolderUpload: folderUpload, uploadPrefix: folderUploadPrefix, flattenUpload: flattenFolderUpload });
}

