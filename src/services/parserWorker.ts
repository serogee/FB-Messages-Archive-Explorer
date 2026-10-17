import { parseMessengerJsonContent, mergeMessengerData, normalizeMessengerData } from './parser';
import type { MessengerThread } from '../types/messenger';
import { FILE_READ_CONCURRENCY, LiveConcurrencyLimit, mapWithConcurrency } from './concurrency';

const concurrency = new LiveConcurrencyLimit(FILE_READ_CONCURRENCY);
type ParserRequest = { files: File[]; concurrency?: number } | { type: 'concurrency'; concurrency: number };

self.onmessage = async (e: MessageEvent<ParserRequest>) => {
  if ('type' in e.data && e.data.type === 'concurrency') {
    if (Number.isInteger(e.data.concurrency) && e.data.concurrency >= 1 && e.data.concurrency <= 16) concurrency.set(e.data.concurrency);
    return;
  }
  try {
    const { files, concurrency: requestedConcurrency } = e.data as { files: File[]; concurrency?: number };
    if (Number.isInteger(requestedConcurrency) && requestedConcurrency! >= 1 && requestedConcurrency! <= 16) concurrency.set(requestedConcurrency!);
    if (!files || files.length === 0) {
      throw new Error('No files provided');
    }
    
    let complete = true;
    const results = await mapWithConcurrency(files, concurrency, async file => {
      try {
        const text = await file.text();
        const data = parseMessengerJsonContent(text);
        if (!Array.isArray(data?.messages)) throw new Error('Invalid messages array.');
        return data;
      } catch {
        complete = false;
        return null;
      }
    });
    const parsedData = results.filter((data): data is MessengerThread => data !== null);
    if (!parsedData.length) throw new Error('No readable message JSON files.');
    
    const base = normalizeMessengerData(mergeMessengerData(parsedData));
      
    self.postMessage({ type: 'success', data: base, complete });
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
