// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import { buildMetaAttachmentReferenceIndex } from '../src/services/metaAttachmentReferences';
import { getFacebookStickerDeletionTargets } from '../src/services/facebookStickerReferences';
import { buildMetaChatDeletionPlan } from '../src/services/metaChatDeletion';
import type { CalculationProgress } from '../src/services/calculationProgress';

if (!File.prototype.text) {
  File.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

const conversation = (title = 'A') => JSON.stringify({
  title, participants: [{ name: title }],
  messages: [{ sticker: { uri: 'messages/stickers_used/shared.png' } }],
});

describe('Meta conversation discovery', () => {
  it('excludes ordinary attached JSON and nested documents after recognizing the parent conversation', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: {
        // "files" is enumerated before the conversation file.
        files: {
          'broken.json': 'not valid JSON',
          'conversation.json': conversation('Attached conversation'),
          nested: { 'conversation.json': conversation('Nested attached conversation') },
        },
        photos: { 'unreadable.json': 'ignored' },
        'message_1.json': conversation(),
      } },
      stickers_used: { 'shared.png': 'sticker' },
    });
    const chat = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a');
    const files = await chat.getDirectoryHandle('files');
    const readBroken = vi.spyOn(await files.getFileHandle('broken.json'), 'getFile');
    const readPayload = vi.spyOn(await files.getFileHandle('conversation.json'), 'getFile');
    const readNestedPayload = vi.spyOn(await (await files.getDirectoryHandle('nested')).getFileHandle('conversation.json'), 'getFile');
    const unreadable = await (await chat.getDirectoryHandle('photos')).getFileHandle('unreadable.json');
    const readAttachment = vi.spyOn(unreadable, 'getFile').mockRejectedValue(new Error('Unreadable attachment'));
    const index = await buildMetaAttachmentReferenceIndex(root);

    expect(index.complete).toBe(true);
    expect(index.warnings).toEqual([]);
    expect([...index.chatMedia.keys()]).toEqual(['inbox/a']);
    expect(index.mediaOwners.get('stickers_used/shared.png')).toEqual(new Set(['inbox/a']));
    expect(readBroken).not.toHaveBeenCalled();
    expect(readPayload).not.toHaveBeenCalled();
    expect(readNestedPayload).not.toHaveBeenCalled();
    expect(readAttachment).not.toHaveBeenCalled();
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toHaveLength(1);
  });

  it('keeps unlisted conversations, including sections named like media directories', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: { a: {
        'message_1.json': conversation(),
        extra: { retained: { 'message_1.json': conversation('Nested retained chat') } },
      } },
      photos: { unlisted: { 'message_2.json': conversation('Unlisted retained chat') } },
      stickers_used: { 'shared.png': 'keep' },
    });
    const index = await buildMetaAttachmentReferenceIndex(root);

    expect(index.complete).toBe(true);
    expect(index.mediaOwners.get('stickers_used/shared.png')).toEqual(new Set([
      'inbox/a', 'inbox/a/extra/retained', 'photos/unlisted',
    ]));
    expect(await getFacebookStickerDeletionTargets(root, index, new Set(['inbox/a']))).toEqual([]);
  });

  it.each(['malformed', 'unreadable'])('preserves deletion protection for a %s conversation', async failure => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { 'message_1.json': conversation(), videos: { 'video.mp4': 'keep' } },
      retained: { 'message_2.json': failure === 'malformed' ? '{broken' : conversation('Retained') },
    } });
    const inbox = await root.getDirectoryHandle('inbox');
    if (failure === 'unreadable') {
      const file = await (await inbox.getDirectoryHandle('retained')).getFileHandle('message_2.json');
      vi.spyOn(file, 'getFile').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    }
    const index = await buildMetaAttachmentReferenceIndex(root);
    const plan = buildMetaChatDeletionPlan([{
      folderName: 'a', title: 'A', source: 'inbox', participants: [],
      messageCount: 1, folderSize: 0, jsonFileCount: 1, dirHandle: await inbox.getDirectoryHandle('a'),
    }], index);

    expect(index.complete).toBe(false);
    expect(index.warnings[0].path).toBe('inbox/retained/message_2.json');
    expect(plan.chats).toEqual([]);
    expect(plan.blocked[0].kind).toBe('unverified');
  });

  it('updates discovery counts while walking entries without more conversation JSON', async () => {
    const extra = Object.fromEntries(Array.from({ length: 160 }, (_, number) => [`entry_${number}.txt`, 'data']));
    const root = createMockDirectoryHandle('messages', { inbox: { a: {
      'message_1.json': conversation(), extra,
    } } });
    const progress: CalculationProgress[] = [];
    await buildMetaAttachmentReferenceIndex(root, undefined, true, update => progress.push(update));
    const walkingEntries = progress.filter(update => update.stage === 'ownership'
      && update.detail?.startsWith('1 JSON files checked') && update.done === 3);

    expect(walkingEntries.length).toBeGreaterThan(1);
    expect(new Set(walkingEntries.map(update => update.detail)).size).toBeGreaterThan(1);
    expect(progress.at(-1)).toMatchObject({
      stage: 'ownership', label: 'Scanning chat folders', unit: 'folders', done: 4, total: 4,
      detail: '1 JSON files checked · 164 entries discovered',
    });
  });
});
