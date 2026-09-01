export function estimateMessageIndexInChunk(
  startIndex: number,
  endIndex: number,
  chunkTop: number,
  chunkBottom: number,
  activeLine: number,
): number {
  if (endIndex <= startIndex || chunkBottom <= chunkTop) return startIndex;
  const progress = Math.max(0, Math.min(1, (activeLine - chunkTop) / (chunkBottom - chunkTop)));
  const count = endIndex - startIndex + 1;
  return Math.min(endIndex, startIndex + Math.floor(progress * count));
}

export function shouldAcceptBucketChange(
  currentIndex: number,
  nextIndex: number,
  scrollDirection: string | undefined,
): boolean {
  if (currentIndex < 0 || nextIndex < 0) return true;
  if (scrollDirection === 'down' && nextIndex < currentIndex) return false;
  if (scrollDirection === 'up' && nextIndex > currentIndex) return false;
  return true;
}
