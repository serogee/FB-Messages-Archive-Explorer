import { bench, describe } from 'vitest';
import { listChatFolders } from '../../src/services/fileSystem';
import { buildMessengerExportReferenceIndex } from '../../src/services/messengerExport/messengerExportDeletion';
import {
  generateFacebookMessagesRoot,
  generateMessengerReferenceRoot,
} from './generatedData';

const benchOptions = { time: 500, warmupTime: 100 };
const facebook500Root = generateFacebookMessagesRoot(500);
const messenger50Root = generateMessengerReferenceRoot(50);
const messenger250Root = generateMessengerReferenceRoot(250);

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
});
