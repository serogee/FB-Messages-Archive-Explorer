export function findNextNavigableIndex<T>(
  items: T[],
  currentIndex: number,
  step: number,
  isNavigable: (item: T) => boolean,
): number {
  for (let index = currentIndex + step; index >= 0 && index < items.length; index += step) {
    if (isNavigable(items[index])) return index;
  }
  return -1;
}
