// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchive } from '../src/hooks/useArchive';
import { CalculationProgressStore } from '../src/services/calculationProgress';
import * as metaScanning from '../src/services/metaAttachmentReferences';
import * as messengerScanning from '../src/services/messengerExport/messengerExportDeletion';
import * as ownership from '../src/services/attachmentReferenceIndex';
import { listMessengerExportChatsIndexed } from '../src/services/messengerExport/messengerExportLoader';
import { computeMessengerExportChatSizeFromIndex } from '../src/services/messengerExport/messengerExportSize';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

if (!File.prototype.text) File.prototype.text = function() {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(this);
  });
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

type Format = 'facebook' | 'instagram' | 'messenger';
function fixture(format: Format) {
  const path = format === 'messenger' ? 'media/shared.png' : 'messages/inbox/a/photos/shared.png';
  const json = (name: string, paths = [path]) => JSON.stringify(format === 'messenger'
    ? { threadName: name, participants: ['Alice', 'Tester'], messages: [{ senderName: 'Alice', timestamp: 1, text: name, media: paths.map(uri => ({ uri })) }] }
    : { title: name, participants: [{ name: 'Alice' }], messages: [{ sender_name: 'Alice', timestamp_ms: 1, photos: paths.map(uri => ({ uri })) }] });
  const tree = format === 'messenger'
    ? { 'a.json': json('A'), 'b.json': json('B'), media: { 'shared.png': '123' } }
    : { inbox: { a: { 'message_1.json': json('A'), photos: { 'shared.png': '123' } }, b: { 'message_1.json': json('B') } } };
  const activity = format === 'instagram' ? 'your_instagram_activity' : 'your_facebook_activity';
  const root = createMockDirectoryHandle(format === 'messenger' ? 'messages' : 'export', format === 'messenger' ? tree : { [activity]: { messages: tree } });
  const messagesRoot = async () => format === 'messenger' ? root : (await root.getDirectoryHandle(activity)).getDirectoryHandle('messages');
  return { root, messagesRoot, json, identity: format === 'messenger' ? path : 'inbox/a/photos/shared.png',
    async file(name = 'b') {
      const messages = await messagesRoot();
      return format === 'messenger' ? messages.getFileHandle(`${name}.json`)
        : (await (await messages.getDirectoryHandle('inbox')).getDirectoryHandle(name)).getFileHandle('message_1.json');
    } };
}
function mount(root: FileSystemDirectoryHandle, enabled = false) {
  const picker = vi.fn(async () => root);
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: picker });
  return { ...renderHook(({ enabled }) => useArchive(enabled), { initialProps: { enabled } }), picker };
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function replace(file: FileSystemFileHandle, text: string) {
  const writer = await file.createWritable(); await writer.write(text); await writer.close();
}

describe('ownership follows the deletion setting', () => {
  it.each(['facebook', 'instagram', 'messenger'] as const)('does not build ownership while %s deletion is disabled', async format => {
    const data = fixture(format);
    const owners = vi.spyOn(ownership, 'addAttachmentOwner');
    const meta = vi.spyOn(metaScanning, 'buildMetaAttachmentReferenceIndex');
    const messenger = vi.spyOn(messengerScanning, 'buildMessengerExportReferenceIndex');
    const { result } = mount(data.root);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    expect(result.current.inboxList).toHaveLength(2);
    expect(result.current.attachmentReferenceIndex).toBeNull();
    expect(result.current.attachmentReferenceScan).toBeNull();
    expect(result.current.attachmentReferenceIndexLoading).toBe(false);
    expect(owners).not.toHaveBeenCalled(); expect(meta).not.toHaveBeenCalled(); expect(messenger).not.toHaveBeenCalled();
    await expect(result.current.getDeleteInfo(result.current.inboxList[0])).rejects.toMatchObject({ name: 'AbortError' });
    await expect(result.current.deleteChats([result.current.inboxList[0]])).rejects.toMatchObject({ name: 'AbortError' });
    if (format === 'messenger') expect(result.current.inboxList.every(entry => entry._sizeIncludesMedia)).toBe(true);
  });

  it.each(['facebook', 'instagram', 'messenger'] as const)('clears completed %s ownership and reads changed JSON when enabled again', async format => {
    const data = fixture(format);
    const scan = format === 'messenger' ? vi.spyOn(messengerScanning, 'buildMessengerExportReferenceIndex')
      : vi.spyOn(metaScanning, 'buildMetaAttachmentReferenceIndex');
    const { result, rerender } = mount(data.root);
    await act(async () => { await result.current.openFolder(); });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(2));
    const oldIndex = result.current.attachmentReferenceIndex;
    rerender({ enabled: false });
    expect(result.current.attachmentReferenceIndex).toBeNull(); expect(result.current.attachmentReferenceScan).toBeNull();
    await replace(await data.file(), data.json('B', []));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(1));
    expect(result.current.attachmentReferenceIndex).not.toBe(oldIndex);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it.each(['facebook', 'messenger'] as const)('ignores late %s reads after an off/on transition', async format => {
    const data = fixture(format);
    const { result, rerender } = mount(data.root);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    const file = await data.file(); const read = file.getFile.bind(file); const pending = gate();
    const reads = vi.spyOn(file, 'getFile').mockImplementationOnce(async () => { const snapshot = await read(); await pending.promise; return snapshot; });
    rerender({ enabled: true });
    await waitFor(() => expect(reads).toHaveBeenCalledOnce());
    rerender({ enabled: false });
    expect(result.current.attachmentReferenceScan).toBeNull(); expect(result.current.attachmentReferenceIndexLoading).toBe(false);
    await replace(file, data.json('B', []));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(1));
    const currentIndex = result.current.attachmentReferenceIndex;
    await act(async () => { pending.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(result.current.attachmentReferenceIndex).toBe(currentIndex);
    expect(result.current.attachmentReferenceScan?.status).toBe('complete');
  });

  it.each(['facebook', 'messenger'] as const)('waits for %s listing to finish after off/on during loading', async format => {
    const data = fixture(format); const file = await data.file('a'); const read = file.getFile.bind(file); const pending = gate();
    const heldRead = format === 'messenger' ? 2 : 1; // Messenger detection reads the first JSON before listing.
    let calls = 0;
    const reads = vi.spyOn(file, 'getFile').mockImplementation(async () => { const snapshot = await read(); if (++calls === heldRead) await pending.promise; return snapshot; });
    const scan = format === 'messenger' ? vi.spyOn(messengerScanning, 'buildMessengerExportReferenceIndex')
      : vi.spyOn(metaScanning, 'buildMetaAttachmentReferenceIndex');
    const { result, rerender } = mount(data.root, true);
    let opening!: Promise<boolean>;
    act(() => { opening = result.current.openFolder(); });
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(heldRead));
    rerender({ enabled: false }); rerender({ enabled: true });
    expect(scan).not.toHaveBeenCalled();
    await act(async () => { pending.release(); await opening; });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(2));
    expect(scan).toHaveBeenCalledOnce(); expect(result.current.inboxList).toHaveLength(2);
  });

  it('keeps Messenger size metadata when ownership collection is canceled during listing', async () => {
    const data = fixture('messenger'); const controller = new AbortController();
    const owners = vi.spyOn(ownership, 'addAttachmentOwner');
    const listing = await listMessengerExportChatsIndexed(data.root, done => {
      if (done === 1) controller.abort();
    }, undefined, { collectOwnership: true, ownershipSignal: controller.signal });
    expect(listing.chatIndex).toBeUndefined(); expect(listing.entries).toHaveLength(2);
    expect(listing.sizeMetadata.jsonSizes.size).toBe(2); expect(owners).toHaveBeenCalledTimes(1);
    expect('referenceIndex' in listing.sizeMetadata).toBe(false);
    expect(computeMessengerExportChatSizeFromIndex('b.json', listing.sizeMetadata, new Map([['media/shared.png', 3]])))
      .toBe(listing.sizeMetadata.jsonSizes.get('b.json')! + 3);
  });

  it('forwards a newly enabled Messenger scan counter to deletion preparation', async () => {
    const data = fixture('messenger'); const { result, rerender } = mount(data.root);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    const file = await data.file(); const read = file.getFile.bind(file); const pending = gate();
    const reads = vi.spyOn(file, 'getFile').mockImplementationOnce(async () => { const snapshot = await read(); await pending.promise; return snapshot; });
    rerender({ enabled: true });
    await waitFor(() => expect(reads).toHaveBeenCalledOnce());
    const progress = new CalculationProgressStore();
    const updates: Array<ReturnType<typeof progress.getSnapshot>> = [];
    const unsubscribe = progress.subscribe(() => updates.push(progress.getSnapshot()));
    const details = result.current.getDeleteInfo(result.current.inboxList[0], undefined, undefined, { skipSizes: true, progress });
    await waitFor(() => expect(progress.getSnapshot()).toMatchObject({ stage: 'ownership', done: 1, total: 2, unit: 'files' }));
    await act(async () => { pending.release(); await details; });
    expect(updates).toContainEqual(expect.objectContaining({ stage: 'ownership', done: 2, total: 2 }));
    expect(progress.getSnapshot()).toMatchObject({ stage: 'chat-data', done: 1, total: 1 });
    unsubscribe();
    progress.dispose();
  });

  it.each(['facebook', 'messenger'] as const)('does not publish an old %s archive after replacement', async format => {
    const old = fixture(format); const next = fixture(format);
    await replace(await next.file(), next.json('B', []));
    const { result, rerender, picker } = mount(old.root);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    const file = await old.file(); const read = file.getFile.bind(file); const pending = gate();
    const reads = vi.spyOn(file, 'getFile').mockImplementationOnce(async () => { const snapshot = await read(); await pending.promise; return snapshot; });
    rerender({ enabled: true });
    await waitFor(() => expect(reads).toHaveBeenCalledOnce());
    picker.mockResolvedValue(next.root);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(next.identity)?.size).toBe(1));
    const currentIndex = result.current.attachmentReferenceIndex;
    await act(async () => { pending.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(result.current.attachmentReferenceIndex).toBe(currentIndex);
  });

  it('cancels Meta deletion verification before mutation across an off/on transition', async () => {
    const data = fixture('facebook'); const { result, rerender } = mount(data.root, true);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    const file = await data.file(); const read = file.getFile.bind(file); const pending = gate();
    const reads = vi.spyOn(file, 'getFile').mockImplementationOnce(async () => { const snapshot = await read(); await pending.promise; return snapshot; });
    const remove = vi.spyOn(await (await data.messagesRoot()).getDirectoryHandle('inbox'), 'removeEntry');
    let outcome!: Promise<unknown>;
    act(() => { outcome = result.current.deleteChats([result.current.inboxList.find(entry => entry.title === 'B')!]).catch(error => error); });
    await waitFor(() => expect(reads).toHaveBeenCalledOnce());
    rerender({ enabled: false }); rerender({ enabled: true });
    await act(async () => { pending.release(); await outcome; });
    expect(await outcome).toMatchObject({ name: 'AbortError' }); expect(remove).not.toHaveBeenCalled();
    expect(result.current.inboxList).toHaveLength(2);
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(2));
  });

  it.each(['facebook', 'messenger'] as const)('checks the setting after %s directory lookup and before the first removal', async format => {
    const data = fixture(format); const messages = await data.messagesRoot();
    if (format === 'messenger') {
      const media = await messages.getDirectoryHandle('media');
      const exclusive = await media.getFileHandle('exclusive.png', { create: true });
      await replace(exclusive, 'exclusive');
      await replace(await data.file(), data.json('B', ['media/exclusive.png']));
    }
    const { result, rerender } = mount(data.root, true);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    await waitFor(() => expect(result.current.sizeProgress).toBeNull());
    const directory = await messages.getDirectoryHandle(format === 'messenger' ? 'media' : 'inbox');
    const removeFile = vi.spyOn(directory, 'removeEntry'); const removeJson = vi.spyOn(messages, 'removeEntry');
    const lookup = messages.getDirectoryHandle.bind(messages); const pending = gate(); let held = false; let calls = 0;
    vi.spyOn(messages, 'getDirectoryHandle').mockImplementation(async (name, options) => {
      const found = await lookup(name, options);
      if (name === (format === 'messenger' ? 'media' : 'inbox') && ++calls === (format === 'messenger' ? 1 : 2)) {
        held = true; await pending.promise;
      }
      return found;
    });
    let outcome!: Promise<unknown>;
    act(() => { outcome = result.current.deleteChats([result.current.inboxList.find(entry => entry.title === 'B')!]).catch(error => error); });
    await waitFor(() => expect(held).toBe(true));
    rerender({ enabled: false }); rerender({ enabled: true });
    await act(async () => { pending.release(); await outcome; });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(removeFile).not.toHaveBeenCalled(); expect(removeJson).not.toHaveBeenCalled();
    expect(result.current.inboxList).toHaveLength(2);
  });

  it.each(['facebook', 'messenger'] as const)('lets an accepted %s removal finish without restoring disabled ownership', async format => {
    const data = fixture(format); const { result, rerender } = mount(data.root, true);
    await act(async () => { await result.current.openFolder(); });
    await waitFor(() => expect(result.current.attachmentReferenceScan?.status).toBe('complete'));
    const selected = result.current.inboxList.find(entry => entry.title === 'B')!;
    const directory = format === 'messenger' ? data.root : await (await data.messagesRoot()).getDirectoryHandle('inbox');
    const remove = directory.removeEntry.bind(directory); const pending = gate();
    const removing = vi.spyOn(directory, 'removeEntry').mockImplementationOnce(async (...args) => { await pending.promise; return remove(...args); });
    let deletion!: ReturnType<typeof result.current.deleteChats>;
    act(() => { deletion = result.current.deleteChats([selected]); });
    await waitFor(() => expect(removing).toHaveBeenCalledOnce());
    rerender({ enabled: false });
    await act(async () => { pending.release(); await deletion; });
    expect((await deletion).deleted).toHaveLength(1);
    expect(result.current.attachmentReferenceIndex).toBeNull(); expect(result.current.attachmentReferenceScan).toBeNull();
    expect(result.current.inboxList).toHaveLength(1);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.attachmentReferenceIndex?.mediaOwners.get(data.identity)?.size).toBe(1));
  });
});
