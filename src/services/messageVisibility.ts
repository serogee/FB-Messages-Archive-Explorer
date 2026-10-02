// Original message indices remain stable when notices are hidden. Compute
// neighbors once so a long hidden run is not scanned again for every row.
export function getVisibleMessageNeighbors(visibility: Uint8Array): { previous: Int32Array; next: Int32Array } {
  const previous = new Int32Array(visibility.length);
  const next = new Int32Array(visibility.length);
  let index = -1;
  for (let i = 0; i < visibility.length; i++) {
    previous[i] = index;
    if (!visibility[i]) index = i;
  }
  index = -1;
  for (let i = visibility.length - 1; i >= 0; i--) {
    next[i] = index;
    if (!visibility[i]) index = i;
  }
  return { previous, next };
}
