import type { MessengerThread } from '../types/messenger';
import { parseMessengerJsonContent, mergeMessengerData, normalizeMessengerData } from './parser';

export async function readReactionFile(file: File): Promise<{ text: string; hash: string }> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    text: new TextDecoder().decode(bytes),
    hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
  };
}
export function validateReactionInput(data: unknown): void {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(data) || !Array.isArray(data.messages)) throw new Error('Invalid message JSON: messages must be an array.');
  if (Object.hasOwn(data, 'participants') && (!Array.isArray(data.participants) || data.participants.some(p => !object(p) || typeof p.name !== 'string'))) throw new Error('Invalid participants.');
  for (const msg of data.messages) {
    if (!object(msg)) throw new Error('Invalid message entry.');
    if (Object.hasOwn(msg, 'reactions') && (!Array.isArray(msg.reactions) || msg.reactions.some(r => !object(r) || typeof r.actor !== 'string' || typeof r.reaction !== 'string'))) throw new Error('Invalid reactions.');
    for (const key of ['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media']) {
      if (Object.hasOwn(msg, key) && (!Array.isArray(msg[key]) || msg[key].some(item => !object(item)))) throw new Error(`Invalid ${key}.`);
    }
  }
}
export async function parseReactionFiles(files: File[], strict: boolean): Promise<MessengerThread> {
  const parts: MessengerThread[] = [], snapshot: [string, string][] = [];
  for (const file of files) {
    const { text, hash } = await readReactionFile(file);
    if (strict) validateReactionInput(JSON.parse(text));
    const parsed = parseMessengerJsonContent(text);
    parts.push(parsed);
    snapshot.push([file.name, hash]);
  }
  const data = normalizeMessengerData(mergeMessengerData(parts));
  data._reactionSnapshot = JSON.stringify(snapshot);
  return data;
}
