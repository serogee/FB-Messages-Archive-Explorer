import type { ReadableDirectoryHandle } from '../types/fileSystem';
import { getOrderedMessageFileNames } from './parser';
export interface ReactionConversation { id: string; handle: ReadableDirectoryHandle; files: string[] }
export const reactionConversationId = (source: string, folderName: string) => `${source}:${folderName}`;
const sections = { inbox: 'inbox', archived_threads: 'archived', message_requests: 'requests', e2ee_cutover: 'e2ee' } as const;
export function checkReactionAbort(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); }
export async function* iterateReactionConversations(root: ReadableDirectoryHandle, signal: AbortSignal, beforeRead?: () => Promise<void>): AsyncGenerator<ReactionConversation> {
  const ready = async () => { await beforeRead?.(); checkReactionAbort(signal); };
  async function* entries(handle: ReadableDirectoryHandle) {
    const iterator = handle.entries();
    try {
      while (true) {
        await ready();
        const item = await iterator.next();
        await ready();
        if (item.done) return;
        yield item.value;
      }
    } finally { await iterator.return?.(); }
  }
  const present = new Set<string>();
  for await (const [name, handle] of entries(root)) {
    checkReactionAbort(signal);
    if (Object.hasOwn(sections, name) && handle.kind !== 'directory') throw new Error(`Invalid message section: ${name} is not a folder.`);
    if (handle.kind === 'directory') present.add(name);
  }
  for (const [section, source] of Object.entries(sections)) {
    if (!present.has(section)) continue;
    await ready();
    const dir = await root.getDirectoryHandle(section);
    for await (const [folderName, handle] of entries(dir)) {
      checkReactionAbort(signal);
      if (handle.kind !== 'directory') continue;
      const names: string[] = [];
      for await (const [name, part] of entries(handle)) { checkReactionAbort(signal); if (part.kind === 'file') names.push(name); }
      const files = getOrderedMessageFileNames(names);
      if (!files.length) throw new Error(`No message JSON in ${section}/${folderName}.`);
      const numbered = files.map(name => Number(name.match(/^message_(\d+)\.json$/i)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
      if (numbered.some((n, i) => n !== i + 1)) throw new Error(`Message parts may be missing in ${section}/${folderName}.`);
      yield { id: reactionConversationId(source, folderName), handle, files };
    }
  }
  checkReactionAbort(signal);
}
export async function discoverReactionConversations(root: ReadableDirectoryHandle, signal: AbortSignal, beforeRead?: () => Promise<void>): Promise<ReactionConversation[]> {
  const conversations: ReactionConversation[] = [];
  for await (const conversation of iterateReactionConversations(root, signal, beforeRead)) conversations.push(conversation);
  return conversations;
}
