import { bench, describe } from 'vitest';
import { listChatFolders } from '../../src/services/fileSystem';
import { computeFacebookDeleteInfo } from '../../src/hooks/useArchive';
import {
  buildMessengerExportReferenceIndex,
  removeMediaFiles,
  type MessengerExportMediaDeletionTarget,
} from '../../src/services/messengerExport/messengerExportDeletion';
import type { WritableDirectoryHandle } from '../../src/types/fileSystem';
import type { ChatListEntry } from '../../src/types/messenger';
import {
  generateFacebookMessagesRoot,
  generateMessengerReferenceRoot,
} from './generatedData';

const benchOptions = { time: 500, warmupTime: 100 };
const facebook500Root = generateFacebookMessagesRoot(500);
const messenger50Root = generateMessengerReferenceRoot(50);
const messenger250Root = generateMessengerReferenceRoot(250);
const deletionEntries = Array.from({ length: 100 }, (_, index) => {
  const dirHandle = {
    kind: 'directory' as const,
    name: `chat-${index}`,
    async *entries() {
      yield ['message_1.json', {
        kind: 'file' as const,
        name: 'message_1.json',
        getFile: async () => new File(['message'], 'message_1.json'),
      }] as const;
    },
  } as ChatListEntry['dirHandle'];
  return {
    folderName: `chat-${index}`,
    title: `Chat ${index}`,
    participants: [],
    messageCount: 1,
    folderSize: 0,
    dirHandle,
    jsonFileCount: 1,
    source: 'inbox' as const,
  };
}) satisfies ChatListEntry[];
const mediaTargets = Array.from({ length: 100 }, (_, index): MessengerExportMediaDeletionTarget => ({
  identity: `media/file-${index}.jpg`,
  path: `file-${index}.jpg`,
}));
const mediaHandle = {
  kind: 'directory' as const,
  name: 'media',
  removeEntry: async () => {},
} as WritableDirectoryHandle;

describe('filesystem performance', () => {
  bench('list 500 Facebook archive chats', async () => {
    await listChatFolders(facebook500Root, 'inbox', 'inbox');
  }, benchOptions);

  bench('build Messenger reference index for 50 chats', async () => {
    await buildMessengerExportReferenceIndex(messenger50Root);
  }, benchOptions);

  bench('build Messenger reference index for 250 chats', async () => {
    await buildMessengerExportReferenceIndex(messenger250Root);
  }, benchOptions);

  bench('calculate Facebook deletion details with one worker', async () => {
    await computeFacebookDeleteInfo(deletionEntries, undefined, 1);
  }, benchOptions);

  bench('calculate Facebook deletion details with four workers', async () => {
    await computeFacebookDeleteInfo(deletionEntries, undefined, 4);
  }, benchOptions);

  bench('remove Messenger media with one worker', async () => {
    await removeMediaFiles(mediaHandle, mediaTargets, 1);
  }, benchOptions);

  bench('remove Messenger media with four workers', async () => {
    await removeMediaFiles(mediaHandle, mediaTargets, 4);
  }, benchOptions);
});
