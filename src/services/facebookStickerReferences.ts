import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';
import { mapWithConcurrency } from './concurrency';
import { getDeletableAttachmentIdentities } from './attachmentReferenceIndex';
import type { MetaAttachmentReferenceIndex } from './metaAttachmentReferences';
import type { CalculationProgress } from './calculationProgress';
import { buildMetaAttachmentReferenceIndex } from './metaAttachmentReferences';
import type { MetaArchivePlatform } from './metaAttachmentPaths';

/** The Facebook-specific entry point explicitly supplies the known platform. */
export function buildFacebookStickerReferenceIndex(root: ReadableDirectoryHandle, signal?: AbortSignal,
  platform: MetaArchivePlatform | boolean = 'facebook', onProgress?: (progress: CalculationProgress) => void) {
  return buildMetaAttachmentReferenceIndex(root, signal, platform, onProgress);
}
export { getMetaChatId as getFacebookChatId, getSharedStickerFileName, getSharedStickerIdentity } from './metaAttachmentPaths';
export type FacebookStickerReferenceIndex = MetaAttachmentReferenceIndex;

export interface FacebookStickerDeletionTarget { identity: string; fileName: string; size: number; }

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function getFacebookStickerDeletionTargets(
  root: ReadableDirectoryHandle, index: MetaAttachmentReferenceIndex,
  chatIds: ReadonlySet<string>, signal?: AbortSignal,
  onProgress?: (progress: CalculationProgress) => void,
): Promise<FacebookStickerDeletionTarget[]> {
  throwIfAborted(signal);
  if (!index.deletionSupported) return [];
  const identities = getDeletableAttachmentIdentities(index, chatIds).filter(identity => identity.startsWith('stickers_used/'));
  let done = 0;
  const report = () => onProgress?.({ stage: 'stickers', label: 'Calculating chat sizes', done, total: identities.length, unit: 'files' });
  report();
  if (identities.length === 0) return [];
  let directory: ReadableDirectoryHandle;
  try { directory = await root.getDirectoryHandle('stickers_used'); }
  catch { throwIfAborted(signal); return []; }
  const targets = await mapWithConcurrency(identities, 4, async identity => {
    const fileName = index.mediaFiles.get(identity)!;
    try {
      const file = await (await directory.getFileHandle(fileName)).getFile();
      throwIfAborted(signal);
      return { identity, fileName, size: file.size };
    } catch { throwIfAborted(signal); return null; }
    finally { done++; report(); }
  }, signal);
  return targets.filter((target): target is FacebookStickerDeletionTarget => target !== null);
}

/** Only successfully deleted chats authorize sticker cleanup. */
export async function removeFacebookStickers(
  root: WritableDirectoryHandle, index: MetaAttachmentReferenceIndex,
  successfullyDeletedChatIds: ReadonlySet<string>, targets: readonly FacebookStickerDeletionTarget[],
  signal?: AbortSignal,
): Promise<Array<{ fileName: string; error: unknown }>> {
  throwIfAborted(signal);
  const safe = new Set(index.deletionSupported ? getDeletableAttachmentIdentities(index, successfullyDeletedChatIds) : []);
  const files = targets.filter(target => target.identity.startsWith('stickers_used/')
    && safe.has(target.identity) && index.mediaFiles.get(target.identity) === target.fileName);
  if (files.length === 0) return [];
  const directory = await root.getDirectoryHandle('stickers_used');
  const failures: Array<{ fileName: string; error: unknown }> = [];
  for (const target of files) {
    throwIfAborted(signal);
    try { await directory.removeEntry(target.fileName); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) failures.push({ fileName: target.fileName, error });
    }
  }
  return failures;
}
