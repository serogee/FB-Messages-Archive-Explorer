export type ChatOpeningDirection = 'up' | 'down';

export function shouldCompensateHeightChange({
  direction,
  elementTop,
  viewportTop,
  viewportBottom,
  jumpAnchorTop,
}: {
  direction: ChatOpeningDirection;
  elementTop: number;
  viewportTop: number;
  viewportBottom: number;
  jumpAnchorTop?: number;
}): boolean {
  const anchor = jumpAnchorTop ?? (direction === 'down' ? viewportTop : viewportBottom);
  return elementTop < anchor;
}
