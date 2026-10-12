import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaAttachmentWorkerSession, type MetaAttachmentWorkerRequest, type MetaAttachmentWorkerResponse } from '../src/services/metaAttachmentWorkerSession';
import { createMetaAttachmentAccumulator } from '../src/services/metaAttachmentAccumulator';
import { buildMetaAttachmentReferenceIndex } from '../src/services/metaAttachmentReferences';
import { getFacebookStickerDeletionTargets } from '../src/services/facebookStickerReferences';
import { resolveFacebookMessagesRootInfo } from '../src/services/fileSystem';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Meta ownership worker', () => {
  it('serializes pending file reads, indexes split references, and returns only compact ownership metadata', async () => {
    const postMessage = vi.fn();
    const scope: { onmessage?: (event: MessageEvent<MetaAttachmentWorkerRequest>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', scope);
    await import('../src/services/metaAttachmentWorker');
    const send = (data: MetaAttachmentWorkerRequest) => scope.onmessage!({ data } as MessageEvent<MetaAttachmentWorkerRequest>);
    await send({ id: 0, type: 'init', platform: 'facebook' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const raw = { title: 'A', messages: [{ content: 'Private message content', videos: [{ uri: 'messages/inbox/a/videos/shared.mp4' }] }] };
    const first = send({ id: 1, type: 'file', chatId: 'inbox/a', name: 'message_1.json', file: { text: async () => { await gate; return JSON.stringify(raw); } } as File });
    const second = send({ id: 2, type: 'file', chatId: 'inbox/b', name: 'message_2.json', file: new File([JSON.stringify(raw)], 'message_2.json') });
    const finish = send({ id: 3, type: 'finish' });
    await Promise.resolve();
    expect(postMessage.mock.calls.map(([response]) => response.id)).toEqual([0]);
    release(); await Promise.all([first, second, finish]);
    expect(postMessage.mock.calls.map(([response]) => response.id)).toEqual([0, 1, 2, 3]);
    const result = postMessage.mock.calls.at(-1)![0].value;
    expect(result.mediaOwners.get('inbox/a/videos/shared.mp4')).toEqual(new Set(['inbox/a', 'inbox/b']));
    expect(result.folderReferences.get('inbox/a')).toEqual(new Set(['inbox/a/videos/shared.mp4']));
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('messages');
    expect(() => structuredClone(result)).not.toThrow();
    const fallback = createMetaAttachmentAccumulator('facebook');
    await fallback.process(raw, 'inbox/a', 'message_1.json');
    await fallback.process(raw, 'inbox/b', 'message_2.json');
    expect(result).toEqual(fallback.index);
  });

  it('marks malformed and unreadable conversations incomplete without losing readable owners', async () => {
    const postMessage = vi.fn();
    const scope: { onmessage?: (event: MessageEvent<MetaAttachmentWorkerRequest>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', scope);
    await import('../src/services/metaAttachmentWorker');
    const send = (data: MetaAttachmentWorkerRequest) => scope.onmessage!({ data } as MessageEvent<MetaAttachmentWorkerRequest>);
    await send({ id: 1, type: 'file', chatId: 'inbox/a', name: 'message_1.json', file: new File(['{'], 'message_1.json') });
    await send({ id: 2, type: 'file', chatId: 'inbox/b', name: 'message_1.json', file: { text: async () => { throw new Error('Permission revoked'); } } as File });
    await send({ id: 3, type: 'file', chatId: 'inbox/c', name: 'message_1.json', file: new File([JSON.stringify({ messages: [{ sticker: { uri: 'your_facebook_activity/messages/stickers_used/a.png' } }] })], 'message_1.json') });
    await send({ id: 4, type: 'finish' });
    const result = postMessage.mock.calls.at(-1)![0].value;
    expect(result.complete).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.mediaOwners.get('stickers_used/a.png')).toEqual(new Set(['inbox/c']));
  });

  it('terminates and rejects queued work immediately on abort or worker failure', async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent<MetaAttachmentWorkerResponse>) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() { workers.push(this); }
    }
    const workers: FakeWorker[] = [];
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const session = new MetaAttachmentWorkerSession('facebook', controller.signal);
    const file = new File(['{}'], 'message_1.json');
    const pending = session.process(file, 'inbox/a', file.name, async () => {});
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await expect(session.finish()).rejects.toMatchObject({ name: 'AbortError' });
    // A late response must not revive a canceled session.
    workers[0].onmessage!({ data: { id: 1, type: 'success', value: true } } as MessageEvent<MetaAttachmentWorkerResponse>);
    session.dispose();
    const failed = new MetaAttachmentWorkerSession('facebook');
    const waiting = failed.finish();
    workers[1].onerror!();
    await expect(waiting).rejects.toThrow('worker failed');
    failed.dispose();
  });
});

describe('conservative Meta platform detection', () => {
  it.each(['your_facebook_activity', 'your_instagram_activity'] as const)('recognizes %s when the export or activity folder is selected', async activity => {
    const root = createMockDirectoryHandle('export', { [activity]: { messages: { inbox: {} } } });
    const platform = activity === 'your_facebook_activity' ? 'facebook' : 'instagram';
    expect(await resolveFacebookMessagesRootInfo(root)).toMatchObject({ platform });
    expect(await resolveFacebookMessagesRootInfo(await root.getDirectoryHandle(activity))).toMatchObject({ platform });
  });

  it('keeps stickers from an ambiguous messages root and permits cleanup only after a Facebook prefix proves the platform', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: { a: { 'message_1.json': JSON.stringify({ messages: [{ sticker: { uri: 'stickers_used/a.png' } }] }) } }, stickers_used: { 'a.png': 'keep' } });
    expect(await resolveFacebookMessagesRootInfo(root)).toMatchObject({ platform: 'unknown' });
    const unknown = await buildMetaAttachmentReferenceIndex(root);
    expect(unknown.complete).toBe(true);
    expect(unknown.deletionSupported).toBe(false);
    expect(await getFacebookStickerDeletionTargets(root, unknown, new Set(['inbox/a']))).toEqual([]);
    const json = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getFileHandle('message_1.json');
    const writer = await json.createWritable();
    await writer.write(JSON.stringify({ messages: [{ sticker: { uri: 'your_facebook_activity/messages/stickers_used/a.png' } }] }));
    await writer.close();
    const facebook = await buildMetaAttachmentReferenceIndex(root);
    expect(facebook.deletionSupported).toBe(true);
    expect(await getFacebookStickerDeletionTargets(root, facebook, new Set(['inbox/a']))).toHaveLength(1);
  });

  it('never enables Facebook sticker deletion for Instagram or conflicting platform prefixes', async () => {
    const engine = createMetaAttachmentAccumulator('unknown');
    await engine.process({ messages: [{ sticker: { uri: 'your_instagram_activity/messages/stickers_used/a.png' } }] }, 'inbox/a', 'message_1.json');
    await engine.process({ messages: [{ sticker: { uri: 'your_facebook_activity/messages/stickers_used/a.png' } }] }, 'inbox/b', 'message_1.json');
    expect(engine.index.deletionSupported).toBe(false);
    expect(engine.index.mediaOwners.get('stickers_used/a.png')?.size).toBe(2);
  });
});
