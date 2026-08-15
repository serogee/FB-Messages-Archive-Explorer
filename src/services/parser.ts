import type { MessengerMessage, MessengerThread } from '../types/messenger';

// ── Encoding helpers ───────────────────────────────────────────────

function looksMisencoded(value: string): boolean {
  return /(?:\u00c3.|\u00c2.|\u00e2[\u0080-\u00bf]{1,2}|\u00f0[\u0080-\u00bf])/.test(value);
}

export function fixEncoding(value: string): string {
  const text = String(value || '');
  if (!looksMisencoded(text)) return text;
  try {
    return decodeURIComponent(escape(text));
  } catch {
    return text;
  }
}

function decodeLegacyMessengerJsonContent(content: string): string {
  const replaced = content.replace(
    /\\u00([a-f0-9]{2})|\\u([a-f0-9]{4})/gi,
    (_match, p1: string | undefined, p2: string | undefined) => {
      const code = p1 ? parseInt(p1, 16) : parseInt(p2!, 16);
      return String.fromCharCode(code);
    }
  );
  return decodeURIComponent(escape(replaced));
}

// ── Normalize display encoding ─────────────────────────────────────

function normalizeDisplayEncoding(data: MessengerThread): MessengerThread {
  if (!data || typeof data !== 'object') return data;

  (['title', 'thread_path'] as const).forEach(key => {
    if (typeof (data as unknown as Record<string, unknown>)[key] === 'string') {
      (data as unknown as Record<string, string>)[key] = fixEncoding((data as unknown as Record<string, string>)[key]);
    }
  });

  if (Array.isArray(data.participants)) {
    data.participants = data.participants.map(participant => {
      if (!participant || typeof participant !== 'object') return participant;
      return { ...participant, name: fixEncoding(participant.name) };
    });
  }

  if (Array.isArray(data.messages)) {
    data.messages.forEach(msg => {
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.senderName === 'string') msg.senderName = fixEncoding(msg.senderName);
      if (typeof msg.sender_name === 'string') msg.sender_name = fixEncoding(msg.sender_name);
      if (typeof msg.content === 'string') msg.content = fixEncoding(msg.content);
      if (typeof msg.text === 'string') msg.text = fixEncoding(msg.text);
      if (Array.isArray(msg.reactions)) {
        msg.reactions.forEach(reaction => {
          if (!reaction || typeof reaction !== 'object') return;
          if (typeof reaction.actor === 'string') reaction.actor = fixEncoding(reaction.actor);
          if (typeof reaction.reaction === 'string') reaction.reaction = fixEncoding(reaction.reaction);
        });
      }
    });
  }
  return data;
}

// ── Parse a single JSON file ───────────────────────────────────────

export function parseMessengerJsonContent(content: string): MessengerThread {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    data = JSON.parse(decodeLegacyMessengerJsonContent(content));
  }
  
  // Normalize flat format
  if (data.threadName && !data.thread_path) {
    data.title = data.threadName;
    data.thread_path = `inbox/${data.threadName}`; // synthetic
    
    // Normalize participants from string[] to { name: string }[]
    if (Array.isArray(data.participants) && data.participants.length > 0 && typeof data.participants[0] === 'string') {
      data.participants = data.participants.map((name: string) => ({ name }));
    }
  } else if (content.includes('"thread_path"')) {
    data.messages = (data.messages || []).reverse();
  }
  
  return normalizeDisplayEncoding(data as MessengerThread);
}

// ── Get message file number ────────────────────────────────────────

function getMessageFileNumber(filename: string): number {
  const match = filename.match(/(?:^|[/\\])message_(\d+)\.json$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

// ── Merge multiple data files ──────────────────────────────────────

export function mergeMessengerData(dataFiles: MessengerThread[]): MessengerThread {
  if (!dataFiles.length) throw new Error('No data files to merge');
  const base = { ...dataFiles[0] };
  base.messages = dataFiles.flatMap(data => Array.isArray(data.messages) ? data.messages : []);

  const participantMap = new Map<string, { name: string }>();
  dataFiles.forEach(data => {
    (data.participants || []).forEach(participant => {
      const name = participant.name;
      if (name && !participantMap.has(name)) participantMap.set(name, participant);
    });
  });
  base.participants = Array.from(participantMap.values());
  return base;
}

// ── Timestamps ─────────────────────────────────────────────────────

export function getMessageTimestamp(msg: MessengerMessage): number | null {
  const timestamp = Number(msg?.timestamp_ms ?? msg?.timestamp ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

// ── Normalize (sort chronologically) ───────────────────────────────

export function normalizeMessengerData(data: MessengerThread): MessengerThread {
  if (!Array.isArray(data.messages)) {
    data.messages = [];
    return data;
  }
  data.messages = data.messages
    .map((msg, index) => ({ msg, index, timestamp: getMessageTimestamp(msg) }))
    .sort((a, b) => {
      if (a.timestamp === null && b.timestamp === null) return a.index - b.index;
      if (a.timestamp === null) return 1;
      if (b.timestamp === null) return -1;
      return (a.timestamp - b.timestamp) || (a.index - b.index);
    })
    .map(item => item.msg);
  return data;
}

// ── Participant names ──────────────────────────────────────────────

export function getParticipantNames(data: MessengerThread | null): string[] {
  return (data?.participants || [])
    .map(p => p?.name)
    .filter(Boolean) as string[];
}

// ── Sanitize file name ─────────────────────────────────────────────

export function sanitizeFileName(name: string): string {
  return String(name || 'conversation')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'conversation';
}

// ── Order message JSON files ───────────────────────────────────────

export function getOrderedMessageFileNames(fileNames: string[]): string[] {
  const messageFiles = fileNames.filter(name => /message_\d+\.json$/i.test(name));
  const selected = messageFiles.length ? messageFiles : fileNames.filter(name => /\.json$/i.test(name));
  return selected.sort((a, b) => {
    const numA = getMessageFileNumber(a);
    const numB = getMessageFileNumber(b);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
      return numB - numA;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  });
}
