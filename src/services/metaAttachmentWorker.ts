import { createMetaAttachmentAccumulator } from './metaAttachmentAccumulator';
import type { MetaAttachmentWorkerRequest, MetaAttachmentWorkerResponse } from './metaAttachmentWorkerSession';

let accumulator = createMetaAttachmentAccumulator('unknown');
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<MetaAttachmentWorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      let value: boolean | typeof accumulator.index = true;
      if (request.type === 'init') accumulator = createMetaAttachmentAccumulator(request.platform);
      else if (request.type === 'file') {
        try {
          value = await accumulator.process(JSON.parse(await request.file.text()), request.chatId, request.name);
        } catch (error) {
          accumulator.incomplete(`${request.chatId}/${request.name}`, error instanceof Error ? error.message : 'Unreadable conversation');
          value = /^message_\d+\.json$/i.test(request.name);
        }
      } else value = accumulator.index;
      self.postMessage({ id: request.id, type: 'success', value } satisfies MetaAttachmentWorkerResponse);
    } catch (error) {
      self.postMessage({ id: request.id, type: 'error', error: error instanceof Error ? error.message : 'Attachment ownership indexing failed.' } satisfies MetaAttachmentWorkerResponse);
    }
  });
  return queue;
};
