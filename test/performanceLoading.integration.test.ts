import { afterEach, expect, it, vi } from 'vitest';
import { backgroundPerformanceLimits, configurePerformance, defaultPerformancePreferences, type PerformanceCategory } from '../src/services/performanceSettings';
import { imageThumbnailCache } from '../src/services/imageThumbnailCache';
import { chatVideoPosterCache, videoPosterCache } from '../src/services/videoPosterCache';
import { listMessengerExportChatsIndexed } from '../src/services/messengerExport/messengerExportLoader';
import { buildMessengerExportReferenceIndex, removeMediaFiles } from '../src/services/messengerExport/messengerExportDeletion';
import { buildMessengerExportMediaSizeIndex } from '../src/services/messengerExport/messengerExportSize';
import { computeFacebookDeleteInfo } from '../src/hooks/useArchive';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import type { ChatListEntry } from '../src/types/messenger';

afterEach(() => { vi.restoreAllMocks(); configurePerformance(defaultPerformancePreferences()); });

it('changes chat and gallery video file-read limits independently while previews are queued', async () => {
  const preferences = defaultPerformancePreferences();
  configurePerformance(preferences);
  const root = createMockDirectoryHandle('videos', Object.fromEntries([
    ...Array.from({ length: 6 }, (_, index) => [`chat-${index}.mp4`, 'unreadable video']),
    ...Array.from({ length: 8 }, (_, index) => [`gallery-${index}.mp4`, 'unreadable video']),
  ]));
  const started = { chat: [] as number[], gallery: [] as number[] };
  const releases = { chat: [] as Array<() => void>, gallery: [] as Array<() => void> };
  const handles = (side: 'chat' | 'gallery', count: number) => Promise.all(Array.from({ length: count }, async (_, index) => {
    const handle = await root.getFileHandle(`${side}-${index}.mp4`);
    const gate = new Promise<void>(resolve => { releases[side][index] = resolve; });
    vi.spyOn(handle, 'getFile').mockImplementation(async () => {
      started[side].push(index);
      await gate;
      throw new DOMException('Cannot read video', 'NotReadableError');
    });
    return handle;
  }));
  const [chat, gallery] = await Promise.all([handles('chat', 6), handles('gallery', 8)]);
  const chatRequests = chat.map(handle => chatVideoPosterCache.getOrCreate({ type: 'video', handle }));
  const galleryRequests = gallery.map(handle => videoPosterCache.getOrCreate({ type: 'video', handle }));
  try {
    await vi.waitFor(() => expect(started).toEqual({ chat: [0, 1], gallery: [0, 1, 2, 3] }));
    preferences.advanced = true;
    preferences.advancedLimits.videoPreviews = 1;
    preferences.advancedLimits.galleryVideoPreviews = 6;
    configurePerformance(preferences);
    await vi.waitFor(() => expect(started).toEqual({ chat: [0, 1], gallery: [0, 1, 2, 3, 4, 5] }));
    releases.chat[0]();
    await chatRequests[0];
    expect(started.chat).toEqual([0, 1]);
    preferences.advancedLimits.galleryVideoPreviews = 1;
    configurePerformance(preferences);
    releases.gallery.slice(0, 5).forEach(release => release());
    await Promise.all(galleryRequests.slice(0, 5));
    expect(started.gallery).toHaveLength(6);
    preferences.advancedLimits.videoPreviews = 3;
    configurePerformance(preferences);
    await vi.waitFor(() => expect(started.chat).toEqual([0, 1, 2, 3]));
    expect(started.gallery).toHaveLength(6);
    releases.gallery[5]();
    await vi.waitFor(() => expect(started.gallery).toEqual([0, 1, 2, 3, 4, 5, 6]));
  } finally {
    Object.values(releases).flat().forEach(release => release());
    await Promise.all([...chatRequests, ...galleryRequests]);
    chatVideoPosterCache.clear();
    videoPosterCache.clear();
  }
  expect(started).toEqual({ chat: [0, 1, 2, 3, 4, 5], gallery: [0, 1, 2, 3, 4, 5, 6, 7] });
});

it('applies presets and independent gallery limits to active thumbnail file reads', async () => {
  const preferences = defaultPerformancePreferences();
  preferences.backgroundActivity = 'low';
  configurePerformance(preferences);
  const root = createMockDirectoryHandle('photos', Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`photo-${index}.jpg`, 'unreadable image']),
  ));
  const started: number[] = [];
  const releases: Array<() => void> = [];
  const handles = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const handle = await root.getFileHandle(`photo-${index}.jpg`);
    const gate = new Promise<void>(resolve => { releases[index] = resolve; });
    vi.spyOn(handle, 'getFile').mockImplementation(async () => {
      started.push(index);
      await gate;
      throw new DOMException('Cannot read image', 'NotReadableError');
    });
    return handle;
  }));
  const requests = handles.map(handle => imageThumbnailCache.getOrCreate({ type: 'image', handle }));
  try {
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    preferences.backgroundActivity = 'high';
    configurePerformance(preferences);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    preferences.advanced = true;
    preferences.advancedLimits = { ...backgroundPerformanceLimits('high'), galleryPreviews: 1, attachmentReads: 16 };
    configurePerformance(preferences);
    releases.slice(0, 7).forEach(release => release());
    await Promise.all(requests.slice(0, 7));
    expect(started).toHaveLength(8);
    releases[7]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  } finally {
    releases.forEach(release => release());
    await Promise.all(requests);
    imageThumbnailCache.clear();
  }
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

it('applies a lower size-detail limit between files in already active folders', async () => {
  const preferences = defaultPerformancePreferences();
  preferences.advanced = true; preferences.advancedLimits.sizeDetails = 2;
  configurePerformance(preferences);
  const root = createMockDirectoryHandle('messages', { a: { 'message_1.json': '{}', 'message_2.json': '{}' }, b: { 'message_1.json': '{}', 'message_2.json': '{}' } });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const entries = await Promise.all(['a', 'b'].map(async name => {
    const dirHandle = await root.getDirectoryHandle(name);
    for await (const [fileName, handle] of dirHandle.entries()) if (handle.kind === 'file') {
      const getFile = handle.getFile.bind(handle);
      const key = `${name}/${fileName}`;
      const gate = new Promise<void>(resolve => releases.set(key, resolve));
      vi.spyOn(handle, 'getFile').mockImplementation(async () => { started.push(key); await gate; return getFile(); });
    }
    return { folderName: name, title: name, dirHandle, participants: [], messageCount: 0, folderSize: 0, jsonFileCount: 2, source: 'inbox' } as ChatListEntry;
  }));
  const pending = computeFacebookDeleteInfo(entries);
  await vi.waitFor(() => expect(started).toEqual(['a/message_1.json', 'b/message_1.json']));
  preferences.advancedLimits.sizeDetails = 1;
  configurePerformance(preferences);
  releases.get('a/message_1.json')!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(started).toHaveLength(2);
  releases.get('b/message_1.json')!();
  await vi.waitFor(() => expect(started).toEqual(['a/message_1.json', 'b/message_1.json', 'a/message_2.json']));
  for (const release of releases.values()) release();
  expect(await pending).toMatchObject({ chatFileCount: 4 });
});

it.each(['archiveReads', 'messengerScans', 'sizes', 'sizeDetails', 'deletions'] as const)(
  'resizes active %s work without repeating completed files or exceeding the reduced limit', async category => {
    const preferences = defaultPerformancePreferences();
    preferences.advanced = true;
    preferences.advancedLimits[category] = 1;
    configurePerformance(preferences);
    const started: number[] = [];
    let active = 0;
    const releases: Array<() => void> = [];
    const gates = Array.from({ length: 6 }, () => new Promise<void>(resolve => { releases.push(resolve); }));
    const hold = async (index: number) => {
      started.push(index); active++;
      try { await gates[index]; } finally { active--; }
    };
    const names = gates.map((_, index) => category === 'sizes' || category === 'deletions' ? `photo-${index}.jpg` : `chat-${index}.json`);
    const tree = Object.fromEntries(names.map((name, index) => [name, JSON.stringify({
      threadName: `Chat ${index}`, participants: ['Owner', `Person ${index}`],
      messages: [{ senderName: 'Owner', timestamp: index + 1, text: `Message ${index}`, media: [{ uri: `media/photo-${index}.jpg` }] }],
    })]));
    const root = createMockDirectoryHandle('messages', category === 'sizes' ? { media: tree } : tree);
    const directory = category === 'sizes' ? await root.getDirectoryHandle('media') : root;
    if (category === 'deletions') {
      const remove = directory.removeEntry.bind(directory);
      vi.spyOn(directory, 'removeEntry').mockImplementation(async name => { await hold(names.indexOf(name)); await remove(name); });
    } else {
      for (let index = 0; index < names.length; index++) {
        const file = await directory.getFileHandle(names[index]);
        const getFile = file.getFile.bind(file);
        vi.spyOn(file, 'getFile').mockImplementation(async () => { await hold(index); return getFile(); });
      }
    }
    let work: Promise<unknown>;
    if (category === 'archiveReads') work = listMessengerExportChatsIndexed(root, undefined, undefined, { collectOwnership: false });
    else if (category === 'messengerScans') work = buildMessengerExportReferenceIndex(root);
    else if (category === 'sizes') work = buildMessengerExportMediaSizeIndex(root);
    else if (category === 'sizeDetails') {
      const entries = await Promise.all(names.map(async (name, index): Promise<ChatListEntry> => ({
        folderName: `chat-${index}`, title: `Chat ${index}`, participants: [], messageCount: 1, folderSize: 0,
        dirHandle: { kind: 'directory', name: `chat-${index}`, getDirectoryHandle: root.getDirectoryHandle.bind(root), getFileHandle: root.getFileHandle.bind(root),
          async *entries() { yield ['message_1.json', await root.getFileHandle(name)]; } },
        jsonFileCount: 1, source: 'inbox',
      })));
      work = computeFacebookDeleteInfo(entries);
    } else work = removeMediaFiles(root, names.map(name => ({ identity: `media/${name}`, path: name })));
    await vi.waitFor(() => expect(started).toEqual([0]));
    preferences.advancedLimits[category as PerformanceCategory] = 3;
    configurePerformance(preferences);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    preferences.advancedLimits[category] = 1;
    configurePerformance(preferences);
    releases[0](); releases[1]();
    await vi.waitFor(() => expect(active).toBe(1));
    expect(started).toEqual([0, 1, 2]);
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.forEach(release => release());
    const result = await work;
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    if (category === 'archiveReads') expect(result).toMatchObject({ entries: names.map((_, index) => expect.objectContaining({ title: `Chat ${5 - index}` })) });
    if (category === 'messengerScans') expect(result).toMatchObject({ complete: true, chatMedia: new Map(names.map((name, index) => [name, new Set([`media/photo-${index}.jpg`])])) });
    if (category === 'sizes') {
      const sizes = result as Map<string, number>;
      expect(sizes.size).toBe(12); // Full media paths and unique basename aliases.
      for (const name of names) expect(sizes.get(name)).toBe(sizes.get(`media/${name}`));
    }
    if (category === 'sizeDetails') expect(result).toMatchObject({ chatFileCount: 6 });
    if (category === 'deletions') expect(result).toMatchObject({ completed: expect.any(Array), failures: [] });
  },
);
