// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeleteDialog } from '../src/hooks/useDeleteDialog';
import { MessengerExportIndexIncompleteError, MessengerExportMediaSizeUnavailableError, type MessengerExportDeletionInfo } from '../src/services/messengerExport';
import type { BatchDeleteResult } from '../src/types/deletion';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

type Inputs = Parameters<typeof useDeleteDialog>[0];
const info: MessengerExportDeletionInfo = {
  jsonSize: 10, chatFileCount: 1, mediaSize: 20, totalSize: 30,
  exclusiveMediaFiles: [], exclusiveMediaCount: 1, sharedMediaCount: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function entry(name = 'alice'): ChatListEntry {
  return { folderName: name, title: name, participants: [], messageCount: 1, folderSize: 10,
    dirHandle: createMockDirectoryHandle(name, {}), jsonFileCount: 1, source: 'inbox' };
}

function inputs() {
  return {
    deletionEnabled: true,
    permissionRoot: createMockDirectoryHandle('messages', {}),
    getDeleteInfo: vi.fn<Inputs['getDeleteInfo']>().mockResolvedValue(info),
    updateFolderSize: vi.fn<Inputs['updateFolderSize']>(),
    suspendSizeWork: vi.fn<Inputs['suspendSizeWork']>().mockResolvedValue(undefined),
    resumeSizeWork: vi.fn<Inputs['resumeSizeWork']>(),
    deleteChats: vi.fn<Inputs['deleteChats']>().mockImplementation(async entries => ({ requested: entries.length, deleted: entries, failed: [] })),
    deleteMessengerChatsJsonOnly: vi.fn<Inputs['deleteMessengerChatsJsonOnly']>().mockImplementation(async entries => ({ requested: entries.length, deleted: entries, failed: [] })),
    removeBookmarks: vi.fn<Inputs['removeBookmarks']>().mockResolvedValue(undefined),
    onDeleted: vi.fn<Inputs['onDeleted']>(),
  };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('deletion dialog lifecycle', () => {
  it('rejects preparation replies for a replaced or canceled target', async () => {
    const dependencies = inputs();
    const first = deferred<MessengerExportDeletionInfo>();
    const second = deferred<MessengerExportDeletionInfo>();
    const canceled = deferred<MessengerExportDeletionInfo>();
    dependencies.getDeleteInfo.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(canceled.promise);
    const a = entry(); const b = entry('bob');
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    act(() => result.current.request(a));
    const oldSignal = dependencies.getDeleteInfo.mock.calls[0][1]!;
    act(() => result.current.request(b));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { first.resolve({ ...info, totalSize: 100 }); });
    expect(result.current.target).toBe(b);
    expect(result.current.preparation.status).toBe('loading');
    await act(async () => { second.resolve(info); });
    expect(result.current.preparation).toMatchObject({ status: 'ready', info });
    act(() => result.current.request(a));
    act(() => result.current.cancel());
    await act(async () => {
      dependencies.getDeleteInfo.mock.calls[2][2]?.(info);
      canceled.resolve(info);
    });
    expect(result.current.target).toBeNull();
    expect(result.current.preparation).toEqual({ status: 'loading', calculatingSizes: false });
  });

  it('keeps skip-check sizing separate from skipping calculation', async () => {
    const dependencies = inputs();
    dependencies.getDeleteInfo.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    act(() => result.current.request(entry()));
    expect(result.current.preparation).toMatchObject({ status: 'loading', calculatingSizes: false });
    act(() => result.current.skipCheck());
    expect(dependencies.getDeleteInfo.mock.calls[1][3]).toMatchObject({ skipAttachmentCheck: true, skipSizes: false, forceOwnershipCheck: false });
    expect(result.current.preparation).toMatchObject({ status: 'loading', calculatingSizes: true, attachmentCheckSkipped: true });
    if (result.current.preparation.status === 'loading') {
      expect(result.current.preparation.progress?.getSnapshot()?.stage).toBe('sizes');
    }
    act(() => result.current.skipSizes());
    expect(result.current.preparation).toEqual({ status: 'unchecked', attachmentCheckSkipped: true });
    expect(dependencies.getDeleteInfo).toHaveBeenCalledTimes(2);
  });

  it('rechecks attachments after a size skip without restarting size calculation', async () => {
    const dependencies = inputs();
    const pending = deferred<MessengerExportDeletionInfo>();
    dependencies.getDeleteInfo.mockImplementationOnce((_target, _signal, onOwnershipReady) => {
      onOwnershipReady?.(info);
      return pending.promise;
    });
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    act(() => result.current.request(entry()));
    act(() => result.current.skipSizes());
    expect(result.current.preparation).toEqual({ status: 'skipped', info });
    await act(async () => { result.current.checkAttachments(); });
    expect(dependencies.getDeleteInfo.mock.calls[1][3]).toMatchObject({ skipSizes: true, forceOwnershipCheck: true, skipAttachmentCheck: false });
    expect(result.current.preparation).toEqual({ status: 'skipped', info });
    await act(async () => { pending.resolve({ ...info, totalSize: 99 }); });
    expect(result.current.preparation).toEqual({ status: 'skipped', info });
  });

  it.each(['permission', 'size suspension'] as const)('rechecks an off/on policy transition after awaiting %s', async phase => {
    const dependencies = inputs();
    const permission = deferred<PermissionState>();
    const suspension = deferred<void>();
    if (phase === 'permission') {
      vi.spyOn(dependencies.permissionRoot, 'queryPermission').mockResolvedValue('prompt');
      vi.spyOn(dependencies.permissionRoot, 'requestPermission').mockReturnValue(permission.promise);
    } else dependencies.suspendSizeWork.mockReturnValue(suspension.promise);
    const { result, rerender } = renderHook(({ enabled }) => useDeleteDialog({ ...dependencies, deletionEnabled: enabled }), { initialProps: { enabled: true } });
    await act(async () => { result.current.request(entry()); });
    let confirmation!: Promise<void>;
    act(() => { confirmation = result.current.confirm('normal'); });
    await waitFor(() => phase === 'permission'
      ? expect(dependencies.permissionRoot.requestPermission).toHaveBeenCalledOnce()
      : expect(dependencies.suspendSizeWork).toHaveBeenCalledOnce());
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {
      permission.resolve('granted');
      suspension.resolve(undefined);
      await confirmation;
    });
    expect(dependencies.deleteChats).not.toHaveBeenCalled();
    expect(dependencies.removeBookmarks).not.toHaveBeenCalled();
    expect(dependencies.resumeSizeWork).toHaveBeenCalledTimes(phase === 'permission' ? 0 : 1);
    expect(result.current.target).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.resultNotice).toBeNull();
  });

  it('keeps one confirmation active and blocks cancellation during mutation', async () => {
    const dependencies = inputs();
    const pending = deferred<BatchDeleteResult>();
    dependencies.deleteChats.mockReturnValue(pending.promise);
    const target = entry();
    const { result, rerender } = renderHook(({ onDeleted }) => useDeleteDialog({ ...dependencies, onDeleted }), { initialProps: { onDeleted: dependencies.onDeleted } });
    await act(async () => { result.current.request(target); });
    let confirmation!: Promise<void>;
    act(() => { confirmation = result.current.confirm('normal'); });
    await waitFor(() => expect(dependencies.deleteChats).toHaveBeenCalledOnce());
    const replacementCallback = vi.fn<Inputs['onDeleted']>();
    rerender({ onDeleted: replacementCallback });
    act(() => result.current.cancel());
    await act(async () => { await result.current.confirm('json-only'); });
    expect(result.current.target).toBe(target);
    expect(dependencies.deleteMessengerChatsJsonOnly).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ requested: 1, deleted: [target], failed: [] }); await confirmation; });
    expect(dependencies.suspendSizeWork).toHaveBeenCalledOnce();
    expect(dependencies.resumeSizeWork).toHaveBeenCalledOnce();
    expect(dependencies.onDeleted).toHaveBeenCalledWith([target]);
    expect(replacementCallback).not.toHaveBeenCalled();
  });

  it('keeps a permission-denied target retryable', async () => {
    const dependencies = inputs();
    vi.spyOn(dependencies.permissionRoot, 'queryPermission').mockResolvedValue('prompt');
    vi.spyOn(dependencies.permissionRoot, 'requestPermission').mockResolvedValueOnce('denied').mockResolvedValueOnce('granted');
    const target = entry();
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    await act(async () => { result.current.request(target); });
    await act(async () => { await result.current.confirm('normal'); });
    expect(result.current.resultNotice?.message).toBe('Write access was not granted. The chats were not deleted.');
    expect(dependencies.suspendSizeWork).not.toHaveBeenCalled();
    expect(dependencies.deleteChats).not.toHaveBeenCalled();
    expect(result.current.target).toBe(target);
    await act(async () => { await result.current.confirm('normal'); });
    expect(dependencies.deleteChats).toHaveBeenCalledOnce();
    expect(result.current.target).toBeNull();
  });

  it('retries only failed targets and reports bookmark cleanup failure after successful deletion', async () => {
    const dependencies = inputs();
    const a = { ...entry(), _messengerExport: true }; const b = { ...entry('bob'), _messengerExport: true };
    const failure = { entry: b, error: new Error('media removal failed'), partial: true, removedMediaCount: 2, jsonRetained: true };
    dependencies.deleteChats.mockResolvedValueOnce({ requested: 2, deleted: [a], failed: [failure] });
    dependencies.removeBookmarks.mockRejectedValueOnce(new Error('bookmark write failed'));
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    await act(async () => { result.current.request([a, b]); });
    await act(async () => { await result.current.confirm('normal'); });
    expect(dependencies.removeBookmarks).toHaveBeenCalledWith([a]);
    expect(dependencies.onDeleted).toHaveBeenCalledWith([a]);
    expect(dependencies.onDeleted.mock.invocationCallOrder[0]).toBeGreaterThan(dependencies.removeBookmarks.mock.invocationCallOrder[0]);
    expect(result.current.target).toBe(b);
    expect(result.current.resultNotice).toMatchObject({ failures: [failure], bookmarkCleanupError: 'Chats were deleted, but their bookmarks could not be removed.' });
    expect(result.current.toast).toBe('1 of 2 chats deleted; 1 failed; bookmark cleanup failed');
    expect(result.current.preparation.status).toBe('ready');
    await act(async () => { await result.current.confirm('normal'); });
    expect(dependencies.deleteChats.mock.calls[1][0]).toEqual([b]);
    expect(result.current.target).toBeNull();
  });

  it('offers JSON-only recovery after unavailable ownership without invoking normal deletion', async () => {
    const dependencies = inputs();
    dependencies.getDeleteInfo.mockRejectedValue(new MessengerExportIndexIncompleteError());
    const target = { ...entry(), _messengerExport: true };
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    await act(async () => { result.current.request(target); });
    expect(result.current.preparation).toMatchObject({ status: 'error', mediaSafetyUnavailable: true });
    await act(async () => { await result.current.confirm('json-only'); });
    expect(dependencies.deleteMessengerChatsJsonOnly).toHaveBeenCalledWith([target], expect.any(Function));
    expect(dependencies.deleteChats).not.toHaveBeenCalled();
    expect(result.current.toast).toBe('Chat JSON deleted; media retained');
  });

  it('retains verified ownership when media byte totals fail', async () => {
    const dependencies = inputs();
    dependencies.getDeleteInfo.mockRejectedValue(new MessengerExportMediaSizeUnavailableError(info, new Error('size read failed')));
    const { result } = renderHook(() => useDeleteDialog(dependencies));
    await act(async () => { result.current.request({ ...entry(), _messengerExport: true }); });
    expect(result.current.preparation).toMatchObject({ status: 'error', mediaSafetyUnavailable: false, info });
  });

  it('separates picked-folder abort from handled-open reset without resetting on root props alone', async () => {
    const dependencies = inputs();
    const pending = deferred<MessengerExportDeletionInfo>();
    dependencies.getDeleteInfo.mockReturnValue(pending.promise);
    const target = entry();
    const { result, rerender } = renderHook(({ root }) => useDeleteDialog({ ...dependencies, permissionRoot: root }), { initialProps: { root: dependencies.permissionRoot } });
    act(() => result.current.request(target));
    const preparation = result.current.preparation;
    rerender({ root: createMockDirectoryHandle('replacement', {}) });
    expect(result.current.target).toBe(target);
    act(() => result.current.abortForPickedFolder());
    expect(dependencies.getDeleteInfo.mock.calls[0][1]?.aborted).toBe(true);
    expect(result.current.target).toBe(target);
    expect(result.current.preparation).toBe(preparation);
    act(() => result.current.resetAfterHandledOpen());
    await act(async () => { pending.resolve(info); });
    expect(result.current.target).toBeNull();
    expect(result.current.preparation).toEqual({ status: 'loading', calculatingSizes: false });
  });

  it('restarts the 3200 ms toast lifetime and clears timers and preparation on unmount', async () => {
    vi.useFakeTimers();
    const dependencies = inputs();
    const { result, unmount } = renderHook(() => useDeleteDialog(dependencies));
    await act(async () => { result.current.request(entry()); });
    await act(async () => { await result.current.confirm('normal'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { result.current.request(entry('bob')); });
    await act(async () => { await result.current.confirm('normal'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3199); });
    expect(result.current.toast).toBe('1 chat deleted');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.toast).toBeNull();
    await act(async () => { result.current.request(entry()); });
    await act(async () => { await result.current.confirm('normal'); });
    dependencies.getDeleteInfo.mockReturnValue(new Promise(() => {}));
    act(() => result.current.request(entry('pending')));
    const signal = dependencies.getDeleteInfo.mock.calls.at(-1)![1]!;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
