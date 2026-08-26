interface MessageJumpLookup {
  findMessage: () => HTMLElement | null;
  renderChunk: () => Promise<boolean>;
  isCurrent: () => boolean;
}

export async function resolveMessageJumpTarget({
  findMessage,
  renderChunk,
  isCurrent,
}: MessageJumpLookup): Promise<HTMLElement | null> {
  const existing = findMessage();
  if (existing) return isCurrent() ? existing : null;

  const rendered = await renderChunk();
  if (!rendered || !isCurrent()) return null;
  return findMessage();
}
