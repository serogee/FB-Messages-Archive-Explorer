// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../src/hooks/useChat';
import { loadChatMessages } from '../src/services/fileSystem';
import { addMediaToIndex, classifyChatMp4Attachments, processMediaFromDirectory } from '../src/services/media';
import type { ChatListEntry, MediaState, MessengerThread } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

vi.mock('../src/services/fileSystem', () => ({ loadChatMessages: vi.fn() }));
vi.mock('../src/services/media', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/media')>(),
  processMediaFromDirectory: vi.fn(), classifyChatMp4Attachments: vi.fn(),
}));

const entry: ChatListEntry = {
  folderName: 'chat', title: 'Chat', participants: ['Alice'], source: 'inbox',
  messageCount: 1, folderSize: 0, jsonFileCount: 1, dirHandle: createMockDirectoryHandle('chat'),
};
const thread: MessengerThread = {
  title: 'Chat', participants: [{ name: 'Alice' }], thread_path: 'inbox/chat', is_still_participant: true,
  messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'Readable immediately', videos: [{ uri: 'voice.mp4' }] }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadChatMessages).mockResolvedValue(thread);
  vi.mocked(processMediaFromDirectory).mockImplementation(async (_root, state) => {
    addMediaToIndex(state, 'voice.mp4', { type: 'video' });
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('chat loading during media track inspection', () => {
  it('shows messages while native metadata reads wait, then updates audio classification', async () => {
    let finish!: () => void;
    vi.mocked(classifyChatMp4Attachments).mockImplementation((_thread, state) => new Promise<void>(resolve => {
      finish = () => { state.lookup.get('voice.mp4')!.type = 'audio'; resolve(); };
    }));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      const pending = result.current.loadChat(entry);
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.chatData).toBe(thread);
    expect(result.current.mediaState.lookup.get('voice.mp4')!.type).toBe('video');
    const initialState = result.current.mediaState;
    await act(async () => { finish(); });
    expect(result.current.mediaState).not.toBe(initialState);
    expect(result.current.mediaState.lookup.get('voice.mp4')!.type).toBe('audio');
  });

  it.each(['clear', 'another chat'] as const)('discards a late metadata result after %s', async action => {
    let finish!: () => void;
    vi.mocked(classifyChatMp4Attachments).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(classifyChatMp4Attachments).mockResolvedValue(undefined);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      const pending = result.current.loadChat(entry);
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    if (action === 'clear') act(() => result.current.clearChat());
    else await act(async () => {
      const pending = result.current.loadChat({ ...entry, folderName: 'other' });
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    const currentState: MediaState = result.current.mediaState;
    await act(async () => { finish(); });
    expect(result.current.mediaState).toBe(currentState);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the loaded conversation usable if metadata inspection fails', async () => {
    vi.mocked(classifyChatMp4Attachments).mockRejectedValue(new DOMException('Native read failed', 'NotReadableError'));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      const pending = result.current.loadChat(entry);
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(result.current.chatData).toBe(thread);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
