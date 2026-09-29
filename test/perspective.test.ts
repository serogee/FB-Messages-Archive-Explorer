// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveArchivePerspective, saveManualArchivePerspective } from '../src/services/perspective';
import { storageGet, storageRemove, storageSet } from '../src/services/storage';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const storageKey = 'archivePerspectivesV1';
const root = createMockDirectoryHandle('archive', {});
function entry(id: string, participants: string[], messenger = false): ChatListEntry {
  return {
    folderName: id, title: id, participants, source: 'inbox',
    messageCount: 0, folderSize: 0, jsonFileCount: 1, dirHandle: root,
    _messengerExport: messenger, _jsonFileName: messenger ? `${id}.json` : undefined,
  };
}
function ownerChats(messenger = false): ChatListEntry[] {
  return ['Bob', 'Carol', 'David'].map((name, index) => entry(String(index), ['Alice', name], messenger));
}

beforeEach(() => storageRemove(storageKey));

describe('archive perspective resolution', () => {
  it.each([false, true])('detects from three distinct conversations (Messenger: %s)', messenger => {
    const resolution = resolveArchivePerspective(ownerChats(messenger), messenger ? 'messenger' : 'facebook');
    expect(resolution).toMatchObject({ name: 'Alice', source: 'detected' });
  });

  it('does not count duplicate participant pairs as independent evidence', () => {
    const result = resolveArchivePerspective([
      entry('1', ['Alice', 'Bob']), entry('2', ['Bob', 'Alice']), entry('3', ['Alice', 'Carol']),
    ], 'facebook');
    expect(result.name).toBe('');
    expect(storageGet(storageKey)).toBeNull();
  });

  it('leaves conflicting and group-only archives unresolved', () => {
    expect(resolveArchivePerspective([
      entry('1', ['Alice', 'Bob']), entry('2', ['Carol', 'David']),
      entry('3', ['Alice', 'Eve']),
    ], 'facebook').name).toBe('');
    expect(resolveArchivePerspective([
      entry('1', ['Alice', 'Bob', 'Carol']), entry('2', ['Alice', 'Bob', 'David']),
    ], 'facebook').name).toBe('');
    expect(storageGet(storageKey)).toBeNull();
  });

  it('stops inference at the confident prefix, before a later conflicting pair', () => {
    expect(resolveArchivePerspective([
      ...ownerChats(), entry('z', ['Eve', 'Frank']),
    ], 'facebook').name).toBe('Alice');
  });

  it('keeps identity stable across ordering, name normalization, and size updates', () => {
    const original = [entry('a', [' José ', 'Bob']), entry('b', ['José', 'Carol'])];
    const reordered = [
      { ...original[1], folderSize: 123, lastTimestamp: 99 },
      { ...original[0], participants: ['Bob', 'Jose\u0301'] },
    ];
    expect(resolveArchivePerspective(original, 'facebook').archiveKey)
      .toBe(resolveArchivePerspective(reordered, 'facebook').archiveKey);
  });

  it('remembers manual choices independently for each archive', () => {
    const first = ownerChats();
    const second = [entry('different', ['Alice', 'Eve'])];
    const firstResult = resolveArchivePerspective(first, 'facebook');
    const secondResult = resolveArchivePerspective(second, 'facebook');
    saveManualArchivePerspective(firstResult.archiveKey, 'Bob');
    saveManualArchivePerspective(secondResult.archiveKey, 'Eve');
    expect(resolveArchivePerspective(first, 'facebook')).toMatchObject({ name: 'Bob', source: 'manual' });
    expect(resolveArchivePerspective(second, 'facebook')).toMatchObject({ name: 'Eve', source: 'manual' });
  });

  it('uses saved detections and invalidates older detector versions', () => {
    const chats = ownerChats();
    const { archiveKey } = resolveArchivePerspective(chats, 'facebook');
    const saved = JSON.parse(storageGet(storageKey)!);
    saved.records[archiveKey].name = 'Bob';
    storageSet(storageKey, JSON.stringify(saved));
    expect(resolveArchivePerspective(chats, 'facebook').name).toBe('Bob');
    saved.records[archiveKey].detectorVersion = 0;
    storageSet(storageKey, JSON.stringify(saved));
    expect(resolveArchivePerspective(chats, 'facebook').name).toBe('Alice');
  });

  it('recovers from malformed saved data', () => {
    storageSet(storageKey, '{broken');
    expect(resolveArchivePerspective(ownerChats(), 'facebook').name).toBe('Alice');
  });
});
