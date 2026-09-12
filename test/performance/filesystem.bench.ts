import { bench, describe } from 'vitest';
import { listChatFolders } from '../../src/services/fileSystem';
import { computeFacebookDeleteInfo } from '../../src/hooks/useArchive';
import {
  addConversationToChatIndex,
  buildMessengerExportReferenceIndex,
  buildMessengerExportMediaSizeIndex,
  computeMessengerExportChatSize,
  computeMessengerExportChatSizeFromIndex,
  createMessengerExportChatIndex,
  listMessengerExportChatsIndexed,
  removeMediaFiles,
  type MessengerExportMediaDeletionTarget,
} from '../../src/services/messengerExport';
import type { WritableDirectoryHandle } from '../../src/types/fileSystem';
import type { ChatListEntry, MessengerThread } from '../../src/types/messenger';
import {
  generateFacebookMessagesRoot,
  generateMessengerReferenceRoot,
} from './generatedData';

const benchOptions = { time: 500, warmupTime: 100 };
const facebook500Root = generateFacebookMessagesRoot(500);
const messenger50Root = generateMessengerReferenceRoot(50);
const messenger250Root = generateMessengerReferenceRoot(250);
const messengerIndexedListing = await listMessengerExportChatsIndexed(messenger250Root);
const messengerMediaSizeIndex = await buildMessengerExportMediaSizeIndex(messenger250Root);
const listingTimeThreads = Array.from({ length: 250 }, (_, index): MessengerThread => ({
  title: `Chat ${index}`,
  participants: [{ name: 'Alice' }, { name: `Person ${index}` }],
  messages: [{
    sender_name: 'Alice',
    timestamp_ms: index,
    media: [
      { uri: `media/exclusive_${index}.jpg` },
      { uri: `media/shared_${index % 25}.jpg` },
    ],
  }],
}));
const attachmentHeavyThread: MessengerThread = {
  title: 'Attachment heavy',
  participants: [{ name: 'Alice' }],
  messages: Array.from({ length: 10_000 }, (_, index) => ({
    sender_name: 'Alice',
    timestamp_ms: index,
    media: [{ uri: `media/file_${index}.jpg` }],
  })),
};
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

  bench('build listing-time Messenger index for 250 already-parsed chats', () => {
    const index = createMessengerExportChatIndex();
    listingTimeThreads.forEach((thread, position) => {
      addConversationToChatIndex(index, `chat_${position}.json`, 1024, thread);
    });
  }, benchOptions);

  bench('build listing-time index for one chat with 10k attachments', () => {
    const index = createMessengerExportChatIndex();
    addConversationToChatIndex(index, 'attachment_heavy.json', 1024, attachmentHeavyThread);
  }, benchOptions);

  bench('calculate indexed Messenger chat size', () => {
    computeMessengerExportChatSizeFromIndex(
      'chat_0.json',
      messengerIndexedListing.chatIndex,
      messengerMediaSizeIndex
    );
  }, benchOptions);

  bench('calculate Messenger chat size by rereading JSON', async () => {
    await computeMessengerExportChatSize(
      messenger250Root,
      'chat_0.json',
      messengerMediaSizeIndex
    );
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
