import { parseMessengerExportJson } from './messengerExportParser';

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const content = await event.data.file.text();
    const data = parseMessengerExportJson(content);
    self.postMessage({ type: 'success', data });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to parse Messenger export JSON',
    });
  }
};

export {};
