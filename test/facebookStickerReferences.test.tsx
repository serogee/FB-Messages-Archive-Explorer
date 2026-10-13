// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import {
  buildFacebookStickerReferenceIndex, getFacebookChatId, getFacebookStickerDeletionTargets,
  getSharedStickerFileName, removeFacebookStickers,
} from '../src/services/facebookStickerReferences';
import { useArchive } from '../src/hooks/useArchive';
import { AttachmentReferencesContext } from '../src/hooks/useAttachmentReferences';
import { AttachmentUsageIndicators } from '../src/components/AttachmentUsageIndicators';
import { DeleteConfirmModal } from '../src/components/Modals/DeleteConfirmModal';
import { createMessengerExportChatIndex, addConversationToChatIndex } from '../src/services/messengerExport/messengerExportIndex';
import { parseMessengerExportJson } from '../src/services/messengerExport/messengerExportParser';
import type { ResolvedAttachment } from '../src/types/messenger';

if (!File.prototype.text) {
  File.prototype.text = function text() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function conversation(paths: string[], extraMessages: unknown[] = []) {
  return JSON.stringify({
    title: 'Chat', participants: [{ name: 'Alice' }], thread_path: 'inbox/chat',
    messages: [...paths.map((uri, index) => ({ sender_name: 'Alice', timestamp_ms: index + 1, sticker: { uri } })), ...extraMessages],
  });
}

function archiveRoot() {
  return createMockDirectoryHandle('messages', {
    inbox: {
      a: { 'message_1.json': conversation(['messages/stickers_used/shared.webp', 'stickers_used/only.png', 'stickers_used/only.png']) },
      b: {
        'message_1.json': conversation([]),
        'message_2.json': conversation(['your_facebook_activity\\messages\\stickers_used\\shared.webp']),
      },
    },
    stickers_used: { 'shared.webp': new Uint8Array([1, 2, 3]), 'only.png': new Uint8Array([4, 5]), 'orphan.png': 'keep' },
  });
}

async function openArchive(root: FileSystemDirectoryHandle) {
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => root) });
  const hook = renderHook(() => useArchive(true));
  await act(async () => { await hook.result.current.openFolder(); });
  return hook;
}

describe('Facebook shared sticker ownership', () => {
  it('deduplicates references, merges split files and preserves a retained owner', async () => {
    const root = archiveRoot();
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.complete).toBe(true);
    expect(index.mediaOwners.get('stickers_used/shared.webp')).toEqual(new Set(['inbox/a', 'inbox/b']));
    expect(index.mediaOwners.get('stickers_used/only.png')?.size).toBe(1);
    const targets = await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']));
    expect(targets).toEqual([{ identity: 'stickers_used/only.png', fileName: 'only.png', size: 2 }]);
    await removeFacebookStickers(root, index, new Set(['inbox/a']), targets);
    const stickers = await root.getDirectoryHandle('stickers_used');
    await expect(stickers.getFileHandle('shared.webp')).resolves.toBeDefined();
    await expect(stickers.getFileHandle('only.png')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(stickers.getFileHandle('orphan.png')).resolves.toBeDefined();
  });

  it('includes each shared sticker once when a batch selects all owners', async () => {
    const root = archiveRoot();
    const index = await buildFacebookStickerReferenceIndex(root);
    const targets = await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a', 'inbox/b']));
    expect(targets).toHaveLength(2);
    expect(targets.reduce((sum, target) => sum + target.size, 0)).toBe(5);
    // A failed batch member is still a retained owner, even though it was selected.
    await removeFacebookStickers(root, index, new Set(['inbox/a']), targets);
    const stickers = await root.getDirectoryHandle('stickers_used');
    await expect(stickers.getFileHandle('shared.webp')).resolves.toBeDefined();
    await removeFacebookStickers(root, index, new Set(['inbox/a', 'inbox/b']), targets);
    await expect(stickers.getFileHandle('shared.webp')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('finds retained owners in other sections and chats missing from the visible list', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: { 'message_1.json': conversation(['stickers_used/shared.webp']) } },
      filtered_threads: { files: { 'message_2.json': conversation(['stickers_used/shared.webp']) } },
      stickers_used: { 'shared.webp': 'keep' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.mediaOwners.get('stickers_used/shared.webp')?.size).toBe(2);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([]);
  });

  it.each([
    '../messages/stickers_used/shared.webp', 'messages/../stickers_used/shared.webp',
    '/messages/stickers_used/shared.webp',
    'messages/stickers_used/shared.webp?download=1', 'messages/stickers_used/%73hared.webp',
    'messages/stickers_used/shared.svg', 'unknown/stickers_used/shared.webp',
    'your_facebook_activity/stickers_used/shared.webp',
  ])('preserves files when an uncertain reference exists: %s', async path => {
    expect(getSharedStickerFileName(path)).toBeNull();
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        a: { 'message_1.json': conversation(['stickers_used/shared.webp']) },
        b: { 'message_1.json': conversation([path]) },
      },
      stickers_used: { 'shared.webp': 'keep' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.complete).toBe(false);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a', 'inbox/b']))).toEqual([]);
  });

  it('omits missing files and preserves all shared stickers after unreadable or malformed JSON', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: { 'message_1.json': conversation(['stickers_used/missing.png']) } },
      stickers_used: { 'orphan.png': 'keep' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([]);
    const a = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a');
    const file = await a.getFileHandle('message_1.json');
    vi.spyOn(file, 'getFile').mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    expect((await buildFacebookStickerReferenceIndex(root)).complete).toBe(false);
    const writable = await file.createWritable();
    await writable.write('{broken'); await writable.close();
    expect((await buildFacebookStickerReferenceIndex(root)).complete).toBe(false);
  });

  it('rejects ambiguous case and malformed attachment containers', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        a: { 'message_1.json': conversation(['stickers_used/A.png']) },
        b: { 'message_1.json': conversation(['stickers_used/a.png'], [{ photos: 'invalid' }]) },
      }, stickers_used: { 'A.png': 'one', 'a.png': 'two' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.complete).toBe(false);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a', 'inbox/b']))).toEqual([]);
  });

  it('keeps relative path caches separate by chat and attachment category', async () => {
    const repeated = { photos: [{ uri: 'same.png' }, { uri: 'same.png' }], files: [{ uri: 'same.png' }] };
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        a: { 'message_1.json': conversation([], [repeated]), 'message_2.json': conversation([], [repeated]) },
        b: { 'message_1.json': conversation([], [repeated]) },
      },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.complete).toBe(true);
    expect(index.mediaOwners).toEqual(new Map([
      ['inbox/a/photos/same.png', new Set(['inbox/a'])],
      ['inbox/a/files/same.png', new Set(['inbox/a'])],
      ['inbox/b/photos/same.png', new Set(['inbox/b'])],
      ['inbox/b/files/same.png', new Set(['inbox/b'])],
    ]));
    expect(index.folderReferences.size).toBe(0);
  });

  it('still validates conflicting fields and case aliases after caching a reference', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: { 'message_1.json': conversation(['stickers_used/a.png'], [
        { sticker: { uri: 'stickers_used/a.png', filename: 'stickers_used/other.png' } },
        { sticker: { uri: 'stickers_used/A.png' } },
        { sticker: { uri: 'stickers_used/a.png' } },
      ]) } },
      stickers_used: { 'a.png': 'keep', 'A.png': 'keep' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.complete).toBe(false);
    expect(index.warnings.some(warning => warning.reason === 'Ambiguous attachment fields')).toBe(true);
    expect(index.warnings.some(warning => warning.reason.startsWith('Ambiguous local paths:'))).toBe(true);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([]);
  });

  it('bounds parallel reads and waits for every retained owner before completing', async () => {
    const chats = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), {
      'message_1.json': conversation(['stickers_used/shared.webp']),
      // JSON in media directories is still scanned; no folder-name shortcut.
      photos: { 'message_2.json': conversation(['stickers_used/shared.webp']) },
    }]));
    const root = createMockDirectoryHandle('messages', { inbox: chats });
    const inbox = await root.getDirectoryHandle('inbox');
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    for (let i = 0; i < 8; i++) {
      const file = await (await inbox.getDirectoryHandle(String(i))).getFileHandle('message_1.json');
      const read = file.getFile.bind(file);
      vi.spyOn(file, 'getFile').mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await gate;
        try { return await read(); } finally { active--; }
      });
    }
    let completed = false;
    const scan = buildFacebookStickerReferenceIndex(root).then(index => { completed = true; return index; });
    await waitFor(() => expect(active).toBe(4));
    expect(completed).toBe(false);
    release();
    const index = await scan;
    expect(maximum).toBe(4);
    expect(index.complete).toBe(true);
    expect(index.mediaOwners.get('stickers_used/shared.webp')?.size).toBe(16);
    expect(index.chatMedia.size).toBe(16);
  });

  it('never deletes stickers after an aborted scan or deletion', async () => {
    const root = archiveRoot();
    const index = await buildFacebookStickerReferenceIndex(root);
    const targets = await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a', 'inbox/b']));
    const abort = new AbortController(); abort.abort();
    await expect(buildFacebookStickerReferenceIndex(root, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(removeFacebookStickers(root, index, new Set(['inbox/a', 'inbox/b']), targets, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const stickers = await root.getDirectoryHandle('stickers_used');
    await expect(stickers.getFileHandle('shared.webp')).resolves.toBeDefined();
    await expect(stickers.getFileHandle('only.png')).resolves.toBeDefined();
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getFileHandle('message_1.json');
    const getFile = file.getFile.bind(file);
    const duringScan = new AbortController();
    vi.spyOn(file, 'getFile').mockImplementation(async () => { duringScan.abort(); return getFile(); });
    await expect(buildFacebookStickerReferenceIndex(root, duringScan.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts Instagram references without enabling Facebook sticker deletion', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: { 'message_1.json': conversation(['your_instagram_activity/messages/stickers_used/a.png']) } },
      stickers_used: { 'a.png': 'keep' },
    });
    const index = await buildFacebookStickerReferenceIndex(root);
    expect(index.mediaOwners.get('stickers_used/a.png')?.size).toBe(1);
    expect(index.deletionSupported).toBe(false);
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([]);
  });
});

describe('archive shared attachment integration', () => {
  it('preserves global stickers when a directly selected messages folder has no platform evidence', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: { 'message_1.json': conversation(['stickers_used/a.png']) } },
      stickers_used: { 'a.png': 'keep' },
    });
    const { result } = await openArchive(root);
    const info = await result.current.getDeleteInfo(result.current.inboxList);
    expect(info).toMatchObject({ stickerCount: 0, stickersPreservedForSafety: true });
    await act(async () => { await result.current.deleteChats(result.current.inboxList); });
    await expect((await root.getDirectoryHandle('stickers_used')).getFileHandle('a.png')).resolves.toBeDefined();
    expect(result.current.inboxList).toEqual([]);
  });

  it('preserves shared stickers in a recognized Instagram export even with bare reference paths', async () => {
    const root = createMockDirectoryHandle('instagram-export', {
      your_instagram_activity: { messages: {
        inbox: { a: { 'message_1.json': conversation(['stickers_used/a.png']) } },
        stickers_used: { 'a.png': 'keep' },
      } },
    });
    const { result } = await openArchive(root);
    const info = await result.current.getDeleteInfo(result.current.inboxList);
    expect(info).toMatchObject({ stickerCount: 0, stickersPreservedForSafety: true });
    await act(async () => { await result.current.deleteChats(result.current.inboxList); });
    const messages = await (await root.getDirectoryHandle('your_instagram_activity')).getDirectoryHandle('messages');
    await expect((await messages.getDirectoryHandle('stickers_used')).getFileHandle('a.png')).resolves.toBeDefined();
  });

  it('lets the chat list finish while a split-file reference scan is pending', async () => {
    const root = archiveRoot();
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b')).getFileHandle('message_2.json');
    const read = file.getFile.bind(file);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(file, 'getFile').mockImplementation(async () => { await gate; return read(); });
    const { result } = await openArchive(root);
    expect(result.current.loading).toBe(false);
    expect(result.current.inboxList).toHaveLength(2);
    expect(result.current.attachmentReferenceIndex).toBeNull();
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get('stickers_used/shared.webp')?.size).toBe(2));
  });

  it('removes each sticker once after a successful batch and reports cleanup failures', async () => {
    const root = archiveRoot();
    const stickers = await root.getDirectoryHandle('stickers_used');
    const remove = stickers.removeEntry.bind(stickers);
    const removals = vi.spyOn(stickers, 'removeEntry').mockImplementation(async name => {
      if (name === 'only.png') throw new DOMException('denied', 'NotAllowedError');
      await remove(name);
    });
    const { result } = await openArchive(root);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(result.current.inboxList); });
    expect(outcome.deleted).toHaveLength(2);
    expect(outcome.failed).toEqual([]);
    expect(outcome.sharedMediaCleanupFailures).toMatchObject([{ fileName: 'only.png' }]);
    expect(removals.mock.calls.map(call => call[0]).sort()).toEqual(['only.png', 'shared.webp']);
    await expect(stickers.getFileHandle('shared.webp')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(stickers.getFileHandle('only.png')).resolves.toBeDefined();
  });

  it('loads counts in the background, previews sizes, and removes exclusive then shared stickers', async () => {
    const root = archiveRoot();
    const { result } = await openArchive(root);
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.complete).toBe(true));
    const entries = result.current.inboxList;
    const a = entries.find(entry => entry.folderName === 'a')!;
    const preview = await result.current.getDeleteInfo(a);
    expect(preview).toMatchObject({ stickerCount: 1, stickerSize: 2, sharedMediaCount: 1 });
    expect(preview.totalSize).toBe(preview.jsonSize + preview.mediaSize + 2);
    const batchPreview = await result.current.getDeleteInfo(entries);
    expect(batchPreview).toMatchObject({ stickerCount: 2, stickerSize: 5, sharedMediaCount: 0 });
    render(<DeleteConfirmModal entry={a} preparation={{ status: 'ready', info: preview }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Shared stickers:')).toBeDefined();
    expect(screen.getByText('Recoverable:')).toBeDefined();
    expect(screen.getByText('2 B (1 files)')).toBeDefined();
    await act(async () => { await result.current.deleteChats([a]); });
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('stickers_used/shared.webp')?.size).toBe(1);
    const stickers = await root.getDirectoryHandle('stickers_used');
    await expect(stickers.getFileHandle('only.png')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(stickers.getFileHandle('shared.webp')).resolves.toBeDefined();
    await act(async () => { await result.current.deleteChats(result.current.inboxList); });
    await expect(stickers.getFileHandle('shared.webp')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(stickers.getFileHandle('orphan.png')).resolves.toBeDefined();
  });

  it('deletes batch stickers once, while a failed owner keeps its shared file', async () => {
    const root = archiveRoot();
    const inbox = await root.getDirectoryHandle('inbox');
    const removeEntry = inbox.removeEntry.bind(inbox);
    vi.spyOn(inbox, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'b') throw new DOMException('denied', 'NotAllowedError');
      await removeEntry(name, options);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await openArchive(root);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(result.current.inboxList); });
    expect(outcome.deleted.map(getFacebookChatId)).toEqual(['inbox/a']);
    expect(outcome.failed).toHaveLength(1);
    const stickers = await root.getDirectoryHandle('stickers_used');
    await expect(stickers.getFileHandle('shared.webp')).resolves.toBeDefined();
    await expect(stickers.getFileHandle('only.png')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('refreshes ownership before deletion when retained JSON changes after the preview', async () => {
    const root = archiveRoot();
    const { result } = await openArchive(root);
    const a = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    expect((await result.current.getDeleteInfo(a)).stickerCount).toBe(1);
    const b = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b');
    const writable = await (await b.getFileHandle('message_1.json')).createWritable();
    await writable.write(conversation(['stickers_used/only.png'])); await writable.close();
    await act(async () => { await result.current.deleteChats([a]); });
    await expect((await root.getDirectoryHandle('stickers_used')).getFileHandle('only.png')).resolves.toBeDefined();
  });

  it('still removes Messenger WebP media and updates shared counts', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'a.json': JSON.stringify({ threadName: 'A', participants: ['Alice'], messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/a.webp' }] }] }),
      'b.json': JSON.stringify({ threadName: 'B', participants: ['Bob'], messages: [{ senderName: 'Bob', timestamp: 2, media: [{ uri: 'media/a.webp' }] }] }),
      media: { 'a.webp': 'sticker-like media' },
    });
    const { result } = await openArchive(root);
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('media/a.webp')?.size).toBe(2);
    await act(async () => { await result.current.deleteChats(result.current.inboxList); });
    await expect((await root.getDirectoryHandle('media')).getFileHandle('a.webp')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(result.current.inboxList).toEqual([]);
  });
});

describe('cross-chat usage indicators', () => {
  const attachment: ResolvedAttachment = { category: 'photos', mediaPath: './media/a.webp', messageIndex: 0, timestamp: 1, sender: 'Alice', mediaEntry: null, usageCount: 3 };
  it('stacks the distinct-chat count above local usage and updates as owners disappear', () => {
    const chatIndex = createMessengerExportChatIndex();
    const thread = parseMessengerExportJson(JSON.stringify({ threadName: 'A', participants: ['Alice'], messages: [{ senderName: 'Alice', media: [{ uri: 'media/a.webp' }] }] }));
    addConversationToChatIndex(chatIndex, 'a.json', 1, thread);
    addConversationToChatIndex(chatIndex, 'b.json', 1, thread);
    const { rerender } = render(<AttachmentReferencesContext.Provider value={{ index: chatIndex.referenceIndex, standaloneMessenger: true }}><AttachmentUsageIndicators attachment={attachment} /></AttachmentReferencesContext.Provider>);
    expect(screen.getByLabelText('Attachment used in 2 chats')).toBeDefined();
    expect(screen.getByLabelText('Attachment used 3 times in this chat')).toBeDefined();
    const badges = document.querySelector('.gallery-reuse-indicators')!.children;
    expect(badges[0].classList.contains('gallery-cross-chat-indicator')).toBe(true);
    rerender(<AttachmentReferencesContext.Provider value={{ index: chatIndex.referenceIndex, standaloneMessenger: true }}><AttachmentUsageIndicators attachment={{ ...attachment, usageCount: 1 }} /></AttachmentReferencesContext.Provider>);
    expect(screen.getByLabelText('Attachment used in 2 chats')).toBeDefined();
    expect(screen.queryByLabelText('Attachment used 3 times in this chat')).toBeNull();
    chatIndex.referenceIndex.complete = false;
    rerender(<AttachmentReferencesContext.Provider value={{ index: { ...chatIndex.referenceIndex }, standaloneMessenger: true }}><AttachmentUsageIndicators attachment={attachment} /></AttachmentReferencesContext.Provider>);
    expect(screen.getByLabelText('Attachment referenced in 2 indexed chats (ownership unverified)')).toBeDefined();
  });
});
