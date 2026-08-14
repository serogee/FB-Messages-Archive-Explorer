import { parseMessengerJsonContent, getMessageTimestamp } from './parser';
import type { MessengerThread } from '../types/messenger';

self.onmessage = async (e: MessageEvent<{ files: File[] }>) => {
  try {
    const { files } = e.data;
    if (!files || files.length === 0) {
      throw new Error('No files provided');
    }
    
    // 1. Parse all files
    const parsedData: MessengerThread[] = [];
    for (const file of files) {
      const text = await file.text();
      parsedData.push(parseMessengerJsonContent(text));
    }
    
    // 2. Merge data
    const base = { ...parsedData[0] };
    base.messages = parsedData.flatMap(data => Array.isArray(data.messages) ? data.messages : []);

    const participantMap = new Map<string, { name: string }>();
    parsedData.forEach(data => {
      (data.participants || []).forEach(participant => {
        const name = participant.name;
        if (name && !participantMap.has(name)) participantMap.set(name, participant);
      });
    });
    base.participants = Array.from(participantMap.values());

    // 3. Sort chronologically
    base.messages = base.messages
      .map((msg, index) => ({ msg, index, timestamp: getMessageTimestamp(msg) }))
      .sort((a, b) => {
        if (a.timestamp === null && b.timestamp === null) return a.index - b.index;
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return (a.timestamp - b.timestamp) || (a.index - b.index);
      })
      .map(item => item.msg);
      
    self.postMessage({ type: 'success', data: base });
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
