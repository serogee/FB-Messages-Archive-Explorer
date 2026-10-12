// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchive } from '../src/hooks/useArchive';
import { buildMetaAttachmentReferenceIndex } from '../src/services/metaAttachmentReferences';
import { buildMetaChatDeletionPlan } from '../src/services/metaChatDeletion';
import { getMetaAttachmentIdentity } from '../src/services/metaAttachmentPaths';
import { getFacebookStickerDeletionTargets } from '../src/services/facebookStickerReferences';
import { AttachmentReferencesContext } from '../src/hooks/useAttachmentReferences';
import { AttachmentUsageIndicators } from '../src/components/AttachmentUsageIndicators';
import { DeleteConfirmModal } from '../src/components/Modals/DeleteConfirmModal';
import { createMediaState, addMediaToIndex, findMediaFile, processFacebookStickerReferences } from '../src/services/media';
import { formatBatchDeleteResult } from '../src/services/deletionResults';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import type { ResolvedAttachment } from '../src/types/messenger';
import { CalculationProgressStore } from '../src/services/calculationProgress';

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

const sharedVideo = 'your_facebook_activity/messages/inbox/a/videos/shared.mp4';
function chat(title: string, paths: string[] = []) {
  return JSON.stringify({ title, participants: [{ name: 'Alice' }], messages: [
    { sender_name: 'Alice', timestamp_ms: 1, videos: paths.map(uri => ({ uri })) },
  ] });
}
function videoArchive() {
  return createMockDirectoryHandle('messages', {
    inbox: {
      a: { 'message_1.json': chat('Source', [sharedVideo]), videos: { 'shared.mp4': new Uint8Array([1, 2, 3]) } },
      b: { 'message_1.json': chat('Referencing B', [sharedVideo]) },
      c: { 'message_1.json': chat('Referencing C', [sharedVideo]) },
    },
  });
}
async function open(root: FileSystemDirectoryHandle) {
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => root) });
  const hook = renderHook(() => useArchive());
  await act(async () => { await hook.result.current.openFolder(); });
  return hook;
}

describe('Meta cross-folder media deletion protection', () => {
  it('blocks deleting a source chat alone, explains the owners and excludes its recoverable bytes', async () => {
    const root = videoArchive();
    const inbox = await root.getDirectoryHandle('inbox');
    const removal = vi.spyOn(inbox, 'removeEntry');
    const { result } = await open(root);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const info = await result.current.getDeleteInfo(source);
    expect(info).toMatchObject({ deletableChatCount: 0, totalSize: 0, blockedChats: [{ chatId: 'inbox/a', title: 'Source' }] });
    expect(info.blockedChats![0].reason).toContain('Referencing B, Referencing C');
    render(<DeleteConfirmModal entry={source} preparation={{ status: 'ready', info }} onConfirm={() => {}} onCancel={() => {}} />);
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    const dependencies = screen.getByRole('list', { name: 'Chats depending on Source' });
    expect(within(dependencies).getByText('Referencing B')).toBeDefined();
    expect(within(dependencies).getByText('Referencing C')).toBeDefined();
    expect(within(dependencies).getAllByText('Not selected')).toHaveLength(2);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source]); });
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed).toMatchObject([{ entry: source, blocked: true, partial: false }]);
    expect(formatBatchDeleteResult(outcome, false)).toBe('0 of 1 chats deleted; 1 protected');
    expect(removal).not.toHaveBeenCalled();
    expect(result.current.inboxList).toHaveLength(3);
    await expect((await (await inbox.getDirectoryHandle('a')).getDirectoryHandle('videos')).getFileHandle('shared.mp4')).resolves.toBeDefined();
  });

  it('deletes referencing chats before their source even when the source is selected first', async () => {
    const root = videoArchive();
    const inbox = await root.getDirectoryHandle('inbox');
    const removed = vi.spyOn(inbox, 'removeEntry');
    const { result } = await open(root);
    const entries = result.current.inboxList.slice().sort((left, right) => left.folderName.localeCompare(right.folderName));
    expect((await result.current.getDeleteInfo(entries)).blockedChats).toEqual([]);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(entries); });
    expect(outcome.failed).toEqual([]);
    expect(outcome.deleted).toHaveLength(3);
    expect(removed.mock.calls.map(call => call[0])).toEqual(['b', 'c', 'a']);
    await expect(inbox.getDirectoryHandle('a')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps the source and its media when a selected referencing chat fails to delete', async () => {
    const root = videoArchive();
    const inbox = await root.getDirectoryHandle('inbox');
    const remove = inbox.removeEntry.bind(inbox);
    const removal = vi.spyOn(inbox, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'b') throw new DOMException('denied', 'NotAllowedError');
      await remove(name, options);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await open(root);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(result.current.inboxList); });
    expect(outcome.deleted.map(entry => entry.folderName)).toEqual(['c']);
    expect(outcome.failed.find(failure => failure.entry.folderName === 'a')).toMatchObject({ blocked: true, partial: false });
    expect(removal.mock.calls.map(call => call[0])).toEqual(['b', 'c']);
    expect(result.current.inboxList.map(entry => entry.folderName).sort()).toEqual(['a', 'b']);
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('inbox/a/videos/shared.mp4')?.size).toBe(2);
  });

  it('allows unrelated selected chats while protecting a source folder', async () => {
    const root = videoArchive();
    const { result } = await open(root);
    const selected = result.current.inboxList.filter(entry => entry.folderName !== 'c');
    const info = await result.current.getDeleteInfo(selected);
    expect(info.deletableChatCount).toBe(1);
    expect(info.blockedChats?.map(block => block.chatId)).toEqual(['inbox/a']);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(selected); });
    expect(outcome.deleted.map(entry => entry.folderName)).toEqual(['b']);
    expect(outcome.failed).toMatchObject([{ blocked: true }]);
  });

  it('skips media size reads but keeps batch dependency detection and ownership results', async () => {
    const root = videoArchive();
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.complete).toBe(true));
    await act(async () => { await result.current.suspendSizeWork(); });
    const c = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('c');
    const photos = await c.getDirectoryHandle('photos', { create: true });
    const file = await photos.getFileHandle('local.png', { create: true });
    const read = vi.spyOn(file, 'getFile').mockRejectedValue(new Error('Size reads must be skipped'));
    const selected = result.current.inboxList.filter(entry => entry.folderName !== 'b');
    const ownershipReady = vi.fn();
    const info = await result.current.getDeleteInfo(selected, undefined, ownershipReady, { skipSizes: true });
    expect(ownershipReady).toHaveBeenCalledWith(info);
    expect(read).not.toHaveBeenCalled();
    expect(info.deletableChatCount).toBe(1);
    expect(info.blockedChats).toMatchObject([{ chatId: 'inbox/a', kind: 'shared-files', dependencies: [
      { chatId: 'inbox/b', title: 'Referencing B' },
    ] }]);
    render(<DeleteConfirmModal entry={selected} preparation={{ status: 'skipped', info }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('region', { name: 'Protected chats and their dependencies' })).toBeDefined();
    expect(within(screen.getByRole('list', { name: 'Chats depending on Source' })).getByText('Referencing B')).toBeDefined();
    expect(screen.getByText('Size calculation was skipped. Shared attachments were checked.')).toBeDefined();
    expect(screen.getAllByText('Skipped')).toHaveLength(4);
  });

  it('requires the explicit override to remove a source folder and still preserves retained shared stickers', async () => {
    const root = videoArchive();
    const inbox = await root.getDirectoryHandle('inbox');
    const stickers = await root.getDirectoryHandle('stickers_used', { create: true });
    const sticker = await stickers.getFileHandle('shared.png', { create: true });
    const writeSticker = await sticker.createWritable(); await writeSticker.write('keep'); await writeSticker.close();
    for (const name of ['a', 'b', 'c']) {
      const file = await (await inbox.getDirectoryHandle(name)).getFileHandle('message_1.json');
      const raw = JSON.parse(await (await file.getFile()).text());
      raw.messages[0].sticker = { uri: 'messages/stickers_used/shared.png' };
      const writable = await file.createWritable(); await writable.write(JSON.stringify(raw)); await writable.close();
    }
    const { result } = await open(root);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const info = await result.current.getDeleteInfo(source, undefined, undefined, { skipSizes: true });
    const override = vi.fn();
    render(<DeleteConfirmModal entry={source} preparation={{ status: 'skipped', info }} onConfirm={() => {}} onDeleteAnyway={override} onCancel={() => {}} />);
    expect(screen.getByText(/Other chats may lose attachments/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(override).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep protection' }));
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(override).toHaveBeenCalledOnce();
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source], undefined, { allowSharedAttachmentLoss: true }); });
    expect(outcome.failed).toEqual([]);
    expect(outcome.deleted).toEqual([source]);
    await expect(inbox.getDirectoryHandle('a')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect((await inbox.getDirectoryHandle('b')).getFileHandle('message_1.json')).resolves.toBeDefined();
    await expect(stickers.getFileHandle('shared.png')).resolves.toBeDefined();
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('stickers_used/shared.png')?.size).toBe(2);
  });

  it('groups dependencies for multiple protected folders and reports every distinct chat name', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': chat('Source A'), videos: { 'a.mp4': 'a' } },
      b: { 'message_1.json': chat('Source B'), videos: { 'b.mp4': 'b' } },
      c: { 'message_1.json': chat('Retained One', ['messages/inbox/a/videos/a.mp4', 'messages/inbox/b/videos/b.mp4']) },
      d: { 'message_1.json': chat('Retained Two', ['messages/inbox/a/videos/a.mp4']) },
      e: { 'message_1.json': chat('Retained Three', ['messages/inbox/a/videos/a.mp4']) },
      f: { 'message_1.json': chat('Retained Four', ['messages/inbox/a/videos/a.mp4']) },
    } });
    const { result } = await open(root);
    const selected = result.current.inboxList.filter(entry => ['a', 'b'].includes(entry.folderName));
    const info = await result.current.getDeleteInfo(selected, undefined, undefined, { skipSizes: true });
    expect(info.blockedChats).toHaveLength(2);
    render(<DeleteConfirmModal entry={selected} preparation={{ status: 'skipped', info }} onConfirm={() => {}} onDeleteAnyway={() => {}} onCancel={() => {}} />);
    const a = screen.getByRole('list', { name: 'Chats depending on Source A' });
    const b = screen.getByRole('list', { name: 'Chats depending on Source B' });
    expect(within(a).getAllByRole('listitem')).toHaveLength(4);
    expect(within(a).getByText('Retained Four')).toBeDefined();
    expect(within(b).getAllByRole('listitem')).toHaveLength(1);
    expect(within(b).getByText('Retained One')).toBeDefined();
  });

  it('allows an explicit batch override for cycles without affecting normal deletion safeguards', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': chat('A', ['messages/inbox/b/videos/b.mp4']), videos: { 'a.mp4': 'a' } },
      b: { 'message_1.json': chat('B', ['messages/inbox/a/videos/a.mp4']), videos: { 'b.mp4': 'b' } },
    } });
    const { result } = await open(root);
    const entries = result.current.inboxList;
    const info = await result.current.getDeleteInfo(entries, undefined, undefined, { skipSizes: true });
    expect(info.blockedChats).toMatchObject([{ kind: 'cycle', dependencies: [{ title: 'B' }] }, { kind: 'cycle', dependencies: [{ title: 'A' }] }]);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats(entries, undefined, { allowSharedAttachmentLoss: true }); });
    expect(outcome.failed).toEqual([]);
    expect(outcome.deleted).toHaveLength(2);
  });

  it('keeps global shared stickers when folder protection is overridden after an incomplete scan', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        a: { 'message_1.json': JSON.stringify({ title: 'A', messages: [{ sticker: { uri: 'messages/stickers_used/shared.png' } }] }) },
        b: { 'message_1.json': JSON.stringify({ title: 'B', messages: [
          { sticker: { uri: 'messages/stickers_used/shared.png' } }, { photos: 'malformed' },
        ] }) },
      }, stickers_used: { 'shared.png': 'keep' },
    });
    const { result } = await open(root);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const info = await result.current.getDeleteInfo(source, undefined, undefined, { skipSizes: true });
    expect(info.blockedChats).toMatchObject([{ kind: 'unverified', dependencies: [] }]);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source], undefined, { allowSharedAttachmentLoss: true }); });
    expect(outcome.deleted).toEqual([source]);
    expect(outcome.failed).toEqual([]);
    await expect((await root.getDirectoryHandle('stickers_used')).getFileHandle('shared.png')).resolves.toBeDefined();
  });

  it('skips a pending ownership check, preserves global stickers and discards the old scan publication', async () => {
    const root = videoArchive();
    const inbox = await root.getDirectoryHandle('inbox');
    const stickers = await root.getDirectoryHandle('stickers_used', { create: true });
    await stickers.getFileHandle('untouched.png', { create: true });
    const file = await (await inbox.getDirectoryHandle('b')).getFileHandle('message_1.json');
    const getFile = file.getFile.bind(file);
    let reads = 0;
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let oldReadFinished = false;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    vi.spyOn(file, 'getFile').mockImplementation(async () => {
      const result = await getFile();
      const text = result.text.bind(result);
      result.text = async () => {
        const number = ++reads;
        if (number === 2) { await oldGate; oldReadFinished = true; }
        if (number > 2) await newGate;
        return text();
      };
      return result;
    });
    const { result } = await open(root);
    await waitFor(() => expect(reads).toBe(2));
    expect(result.current.attachmentReferenceIndexLoading).toBe(true);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source], undefined, { skipAttachmentCheck: true }); });
    expect(outcome.deleted).toEqual([source]);
    expect(outcome.failed).toEqual([]);
    await expect(stickers.getFileHandle('untouched.png')).resolves.toBeDefined();
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => { releaseOld(); });
    await waitFor(() => expect(oldReadFinished).toBe(true));
    expect(result.current.attachmentReferenceIndex).toBeNull();
    expect(result.current.attachmentReferenceIndexLoading).toBe(true);
    await act(async () => { releaseNew(); });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.complete).toBe(true));
    expect(result.current.attachmentReferenceIndex?.chatMedia.has('inbox/a')).toBe(false);
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('inbox/a/videos/shared.mp4')).toEqual(new Set(['inbox/b', 'inbox/c']));
  });

  it('propagates protection through dependent folders and blocks cycles without mutation', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': chat('A', ['messages/inbox/b/videos/b.mp4']), videos: { 'a.mp4': 'a' } },
      b: { 'message_1.json': chat('B', ['messages/inbox/a/videos/a.mp4']), videos: { 'b.mp4': 'b' } },
      c: { 'message_1.json': chat('C', ['messages/inbox/b/videos/b.mp4']) },
    } });
    const { result } = await open(root);
    const index = await buildMetaAttachmentReferenceIndex(root);
    const entries = result.current.inboxList;
    const partial = buildMetaChatDeletionPlan(entries.filter(entry => entry.folderName !== 'c'), index);
    expect(partial.chats).toEqual([]);
    expect(partial.blocked).toHaveLength(2);
    const all = buildMetaChatDeletionPlan(entries, index);
    expect(all.chats.map(entry => entry.folderName)).toEqual(['c']);
    expect(all.blocked).toHaveLength(2);
    expect(all.blocked[0].reason).toContain("each other's folders");
  });

  it('refreshes ownership after preview and preserves folders when retained JSON becomes unreadable', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': chat('A', ['videos/shared.mp4']), videos: { 'shared.mp4': 'keep' } },
      b: { 'message_1.json': chat('B') },
    } });
    const { result } = await open(root);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    expect((await result.current.getDeleteInfo(source)).deletableChatCount).toBe(1);
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b')).getFileHandle('message_1.json');
    const writable = await file.createWritable();
    await writable.write(chat('B', [sharedVideo])); await writable.close();
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source]); });
    expect(outcome.failed[0]).toMatchObject({ blocked: true });
    vi.spyOn(file, 'getFile').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await act(async () => { outcome = await result.current.deleteChats([source]); });
    expect((outcome.failed[0].error as Error).message).toContain('could not be verified');
    expect(outcome.deleted).toEqual([]);
  });

  it('does not block a source folder for a cross-folder file that is already missing', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': chat('A') }, b: { 'message_1.json': chat('B', [sharedVideo]) },
    } });
    const { result } = await open(root);
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    expect((await result.current.getDeleteInfo(source)).blockedChats).toEqual([]);
    let outcome!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { outcome = await result.current.deleteChats([source]); });
    expect(outcome.failed).toEqual([]);
    expect(outcome.deleted).toHaveLength(1);
  });
});

describe('Meta ownership and cross-chat badges', () => {
  it('calculates selected-folder sizes independently after skipping a pending ownership check', async () => {
    const root = videoArchive();
    const retained = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b')).getFileHandle('message_1.json');
    const read = retained.getFile.bind(retained);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(retained, 'getFile').mockImplementation(async () => { if (++reads > 1) await gate; return read(); });
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('checking'));
    const selected = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const progress = new CalculationProgressStore();
    const ownershipReady = vi.fn();
    const estimate = await result.current.getDeleteInfo(selected, undefined, ownershipReady, { skipAttachmentCheck: true, progress });
    progress.dispose();
    expect(estimate.mediaSize).toBe(3);
    expect(estimate.totalSize).toBeGreaterThan(3);
    expect(estimate.stickerCount).toBe(0);
    expect(estimate.stickersPreservedForSafety).toBe(true);
    expect(ownershipReady).not.toHaveBeenCalled();
    expect(progress.getSnapshot()).toMatchObject({ stage: 'sizes', label: 'Calculating chat sizes' });
    expect(progress.getSnapshot()?.jsonFound).toBeUndefined();
    expect(result.current.attachmentReferenceScan?.status).toBe('checking');
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    expect(progress.getSnapshot()?.stage).toBe('sizes');
  });
  it('counts shared videos using full export paths and keeps identical local basenames separate', async () => {
    const root = videoArchive();
    const index = await buildMetaAttachmentReferenceIndex(root);
    expect(index.complete).toBe(true);
    expect(index.mediaOwners.get('inbox/a/videos/shared.mp4')).toEqual(new Set(['inbox/a', 'inbox/b', 'inbox/c']));
    expect(getMetaAttachmentIdentity('videos/shared.mp4', 'inbox/a', 'videos')).toBe('inbox/a/videos/shared.mp4');
    expect(getMetaAttachmentIdentity('videos/shared.mp4', 'inbox/b', 'videos')).toBe('inbox/b/videos/shared.mp4');
    const attachment: ResolvedAttachment = { mediaPath: 'videos/shared.mp4', category: 'videos', messageIndex: 0, timestamp: 1, sender: 'Alice', mediaEntry: null };
    const { rerender } = render(<AttachmentReferencesContext.Provider value={{ index, standaloneMessenger: false, chatId: 'inbox/a' }}><AttachmentUsageIndicators attachment={attachment} /></AttachmentReferencesContext.Provider>);
    expect(screen.getByLabelText('Attachment used in 3 chats')).toBeDefined();
    rerender(<AttachmentReferencesContext.Provider value={{ index, standaloneMessenger: false, chatId: 'inbox/b' }}><AttachmentUsageIndicators attachment={attachment} /></AttachmentReferencesContext.Provider>);
    expect(screen.queryByLabelText('Attachment used in 3 chats')).toBeNull();
    rerender(<AttachmentReferencesContext.Provider value={{ index, standaloneMessenger: false, chatId: 'inbox/b' }}><AttachmentUsageIndicators attachment={{ ...attachment, mediaPath: sharedVideo }} /></AttachmentReferencesContext.Provider>);
    expect(screen.getByLabelText('Attachment used in 3 chats')).toBeDefined();
  });

  it('keeps remote URLs separate from local stickers and permits proven local cleanup', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        a: { 'message_1.json': JSON.stringify({ title: 'A', messages: [
          { sticker: { uri: 'messages/stickers_used/a.png' }, videos: [{ uri: 'videos/a.mp4' }], photos: [{}, { uri: '' }] },
          { sticker: { ai_stickers: [] } },
        ] }), videos: { 'a.mp4': 'media' } },
        b: { 'message_1.json': JSON.stringify({ title: 'B', messages: [{ sticker: { uri: 'https://example.com/stickers_used/a.png' } }] }) },
      }, stickers_used: { 'a.png': 'local' },
    });
    const index = await buildMetaAttachmentReferenceIndex(root, undefined, 'facebook');
    expect(index.complete).toBe(true);
    expect(index.warnings).toEqual([]);
    expect(index.mediaOwners.get('stickers_used/a.png')).toEqual(new Set(['inbox/a']));
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([{ identity: 'stickers_used/a.png', fileName: 'a.png', size: 5 }]);
    const media = createMediaState();
    addMediaToIndex(media, 'stickers_used/a.png', { type: 'image' });
    expect(findMediaFile(media, 'https://example.com/stickers_used/a.png')).toBeNull();
    await processFacebookStickerReferences(root, [{ sender_name: 'A', timestamp_ms: 1, sticker: { uri: 'https://example.com/stickers_used/a.png' } }], media);
    expect(media.lookup.has('https://example.com/stickers_used/a.png')).toBe(false);
  });

  it('reports a pending background scan and clears the status when counts are ready', async () => {
    const root = videoArchive();
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getFileHandle('message_1.json');
    const read = file.getFile.bind(file);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(file, 'getFile').mockImplementation(async () => { if (++reads > 1) await gate; return read(); });
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceIndexLoading).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.attachmentReferenceScan).toMatchObject({ status: 'checking' });
    const progressSource = result.current.attachmentReferenceScan!.progress;
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.attachmentReferenceIndexLoading).toBe(false));
    expect(result.current.attachmentReferenceScan).toMatchObject({ status: 'complete', progress: progressSource });
    const finishedProgress = progressSource!.getSnapshot()!;
    expect(finishedProgress.done).toBe(finishedProgress.total);
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('inbox/a/videos/shared.mp4')?.size).toBe(3);
  });

  it('restores the completed index when a manual attachment recheck is canceled', async () => {
    const root = videoArchive();
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    const previousIndex = result.current.attachmentReferenceIndex;
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getFileHandle('message_1.json');
    const read = file.getFile.bind(file);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(file, 'getFile').mockImplementation(async () => { await gate; return read(); });
    const controller = new AbortController();
    const check = result.current.getDeleteInfo(source, controller.signal, undefined, {
      skipSizes: true,
      forceOwnershipCheck: true,
    });
    const outcome = check.then(() => null, error => error);

    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('checking'));
    // Do not release the filesystem read until cancellation is observable.
    await act(async () => { controller.abort(); await outcome; });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(result.current.attachmentReferenceIndexLoading).toBe(false));
    expect(result.current.attachmentReferenceIndex).toBe(previousIndex);
    expect(result.current.attachmentReferenceScan?.status).toBe('complete');
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(result.current.attachmentReferenceIndex).toBe(previousIndex);
    expect(result.current.attachmentReferenceScan?.status).toBe('complete');
  });

  it('keeps the initial background scan running when a dialog check is canceled', async () => {
    const root = videoArchive();
    const file = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b')).getFileHandle('message_1.json');
    const read = file.getFile.bind(file);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(file, 'getFile').mockImplementation(async () => { if (++reads > 1) await gate; return read(); });
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('checking'));
    const controller = new AbortController();
    const check = result.current.getDeleteInfo(result.current.inboxList[0], controller.signal, undefined, { skipSizes: true, forceOwnershipCheck: true });
    await act(async () => { controller.abort(); await expect(check).rejects.toMatchObject({ name: 'AbortError' }); });
    expect(result.current.attachmentReferenceScan?.status).toBe('checking');
    expect(result.current.attachmentReferenceIndexLoading).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    expect(result.current.attachmentReferenceIndex?.mediaOwners.get('inbox/a/videos/shared.mp4')?.size).toBe(3);
  });

  it('resets the folder-protection override on a new check and on a different selection', async () => {
    const { result } = await open(videoArchive());
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const info = await result.current.getDeleteInfo(source, undefined, undefined, { skipSizes: true });
    const callbacks = { onConfirm: vi.fn(), onDeleteAnyway: vi.fn(), onCancel: vi.fn() };
    const preparation = { status: 'skipped' as const, info };
    const { rerender } = render(<DeleteConfirmModal entry={source} preparation={preparation} {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<DeleteConfirmModal entry={source} preparation={{ status: 'loading', calculatingSizes: false, sizesSkipped: true }} {...callbacks} />);
    rerender(<DeleteConfirmModal entry={source} preparation={{ status: 'skipped', info }} {...callbacks} />);
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    const other = { ...source, folderName: 'different-source' };
    rerender(<DeleteConfirmModal entry={other} preparation={preparation} {...callbacks} />);
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DeleteConfirmModal entry={source} preparation={preparation} {...callbacks} />);
    expect((screen.getByRole('button', { name: 'Deletion blocked' }) as HTMLButtonElement).disabled).toBe(true);
    expect(callbacks.onDeleteAnyway).not.toHaveBeenCalled();
  });

  it('reports fresh verification in the deletion dialog before any folder mutation', async () => {
    const root = videoArchive();
    const { result } = await open(root);
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.complete).toBe(true));
    const inbox = await root.getDirectoryHandle('inbox');
    const source = result.current.inboxList.find(entry => entry.folderName === 'a')!;
    const retained = await (await inbox.getDirectoryHandle('b')).getFileHandle('message_1.json');
    const read = retained.getFile.bind(retained);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(retained, 'getFile').mockImplementation(async () => { await gate; return read(); });
    const remove = vi.spyOn(inbox, 'removeEntry');
    const verificationProgress = new CalculationProgressStore();
    render(<DeleteConfirmModal entry={source} preparation={{ status: 'skipped' }} deleting verificationProgress={verificationProgress} onConfirm={() => {}} onCancel={() => {}} />);
    const deletion = result.current.deleteChats([source], undefined, { verificationProgress });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Deletion attachment verification' }).textContent).toContain('Scanning for shared attachments'));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { release(); await deletion; });
    expect((await deletion).failed[0]).toMatchObject({ blocked: true });
    expect(remove).not.toHaveBeenCalled();
    verificationProgress.dispose();
  });
});
