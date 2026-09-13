// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAudioMetadata } from '../src/services/audioMetadata';
import { enrichReactionTimestamps, getReactionTimestamp, isReactionNoticeMessage } from '../src/services/reactions';
import { useSettings } from '../src/hooks/useSettings';
import type { MediaEntry, MessengerMessage } from '../src/types/messenger';

afterEach(() => {
  localStorage.clear();
  document.cookie.split(';').forEach(cookie => {
    document.cookie = `${cookie.split('=')[0]}; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('audio metadata', () => {
  it('shares pending work, caches duration and size, and releases the audio element source', async () => {
    const instances: FakeAudio[] = [];
    class FakeAudio {
      preload = '';
      duration = 12.5;
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      removed = false;
      loadCalls = 0;
      set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
      removeAttribute(name: string) { if (name === 'src') this.removed = true; }
      load() { this.loadCalls++; }
    }
    vi.stubGlobal('Audio', class extends FakeAudio { constructor() { super(); instances.push(this); } });
    const getFile = vi.fn(async () => new File(['hello'], 'voice.m4a'));
    const entry: MediaEntry = { type: 'audio', url: 'blob:audio', handle: { kind: 'file', name: 'voice.m4a', getFile } };

    const first = getAudioMetadata(entry);
    const second = getAudioMetadata(entry);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ duration: 12.5, size: 5 });
    await expect(getAudioMetadata(entry)).resolves.toEqual({ duration: 12.5, size: 5 });
    expect(getFile).toHaveBeenCalledOnce();
    expect(instances[0]).toMatchObject({ removed: true, loadCalls: 1 });
  });

  it('returns null duration and releases the source when metadata times out', async () => {
    vi.useFakeTimers();
    class SilentAudio {
      preload = '';
      duration = Number.NaN;
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      removed = false;
      loadCalls = 0;
      set src(_value: string) { /* The browser never reports metadata or an error. */ }
      removeAttribute(name: string) { if (name === 'src') this.removed = true; }
      load() { this.loadCalls++; }
    }
    const instances: SilentAudio[] = [];
    vi.stubGlobal('Audio', class extends SilentAudio { constructor() { super(); instances.push(this); } });
    const entry: MediaEntry = {
      type: 'audio',
      url: 'blob:silent-audio',
      handle: { kind: 'file', name: 'silent.m4a', getFile: async () => new File(['x'], 'silent.m4a') },
    };

    const request = getAudioMetadata(entry);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(request).resolves.toEqual({ duration: null, size: 1 });
    expect(instances[0]).toMatchObject({ removed: true, loadCalls: 1 });
    vi.useRealTimers();
  });

  it('returns null duration and releases the source after an audio metadata error', async () => {
    class ErrorAudio {
      preload = '';
      duration = Number.NaN;
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      removed = false;
      loadCalls = 0;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
      removeAttribute(name: string) { if (name === 'src') this.removed = true; }
      load() { this.loadCalls++; }
    }
    const instances: ErrorAudio[] = [];
    vi.stubGlobal('Audio', class extends ErrorAudio { constructor() { super(); instances.push(this); } });
    const entry: MediaEntry = {
      type: 'audio',
      url: 'blob:error-audio',
      handle: { kind: 'file', name: 'error.m4a', getFile: async () => new File(['x'], 'error.m4a') },
    };

    await expect(getAudioMetadata(entry)).resolves.toEqual({ duration: null, size: 1 });
    expect(instances[0]).toMatchObject({ removed: true, loadCalls: 1 });
  });
});

describe('reaction enrichment', () => {
  it('matches a reaction notice to the preceding message by actor and normalized emoji', async () => {
    const messages: MessengerMessage[] = [
      { sender_name: 'Alice', timestamp_ms: 1, content: 'Hello', reactions: [{ actor: 'Bob', reaction: '👍️' }] },
      { sender_name: 'Bob', timestamp_ms: 25, content: 'Bob reacted 👍 to your message' },
    ];

    expect(isReactionNoticeMessage(messages[1])).toBe(true);
    await enrichReactionTimestamps(messages);
    expect(getReactionTimestamp(messages[0].reactions![0])).toBe(25);
  });

  it('does not mutate reactions when enrichment is already aborted', async () => {
    const messages: MessengerMessage[] = [
      { sender_name: 'Alice', timestamp_ms: 1, reactions: [{ actor: 'Bob', reaction: '❤' }] },
      { sender_name: 'Bob', timestamp_ms: 25, content: 'Bob reacted ❤ to your message' },
    ];
    const controller = new AbortController();
    controller.abort();

    await enrichReactionTimestamps(messages, undefined, controller.signal);
    expect(getReactionTimestamp(messages[0].reactions![0])).toBe(0);
  });
});

describe('settings persistence', () => {
  it('loads persisted settings, migrates the legacy filename template, and updates DOM state', () => {
    const prefix = `majv_${window.location.hostname || 'local'}_setting_`;
    localStorage.setItem(`${prefix}darkMode`, 'false');
    localStorage.setItem(`${prefix}sidebarWidth`, '444');
    localStorage.setItem(`${prefix}attachmentFilenameTemplate`, '{chat} - {date}_{time}_{ms}');
    const { result } = renderHook(() => useSettings());

    expect(result.current.settings).toMatchObject({
      darkMode: false,
      sidebarWidth: 444,
      attachmentFilenameTemplate: '{-chat}_{date}_{time}_{ms}',
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('444px');

    act(() => result.current.setSetting('darkMode', true));
    expect(result.current.settings.darkMode).toBe(true);
    expect(localStorage.getItem(`${prefix}darkMode`)).toBe('1');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to cookies when localStorage throws', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.resetModules();
    const storage = await import('../src/services/storage');

    storage.storageSet('fallback', 'value');
    expect(storage.storageGet('fallback')).toBe('value');
    storage.storageRemove('fallback');
    expect(storage.storageGet('fallback')).toBeNull();
    expect(setItem).toHaveBeenCalled();
    expect(getItem).toHaveBeenCalled();
  });
});
