import { Component, type ReactNode, type RefObject } from 'react';
import { resetChatScrollAnchor } from './chatScrollAnchoring';
interface Props { data: object; getVisibility: () => Uint8Array; containerRef: RefObject<HTMLDivElement | null>; children: ReactNode }
interface Snapshot { index: number; offset: number; bottom: boolean }
// React captures this before DOM mutations, including those in child chunks.
// Layout-effect cleanup would run too late to reliably capture the old geometry.
export class ReactionVisibilityAnchor extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const container = this.props.containerRef.current;
    if (!container || previous.data !== this.props.data || previous.getVisibility === this.props.getVisibility) return null;
    const visibility = this.props.getVisibility();
    const top = container.getBoundingClientRect().top;
    const survivors = Array.from(container.querySelectorAll<HTMLElement>('.message[data-msg-index]')).filter(row => !visibility[Number(row.dataset.msgIndex)]);
    const row = survivors.find(row => row.getBoundingClientRect().bottom > top) || survivors.at(-1);
    return { index: Number(row?.dataset.msgIndex ?? -1), offset: row ? row.getBoundingClientRect().top - top : 0, bottom: container.dataset.isAtBottom === 'true' };
  }
  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null): void {
    const container = this.props.containerRef.current;
    if (!container || !snapshot) return;
    const row = container.querySelector<HTMLElement>(`.message[data-msg-index="${snapshot.index}"]`);
    if (snapshot.bottom) container.scrollTop = container.scrollHeight;
    else if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - snapshot.offset;
    resetChatScrollAnchor(container);
  }
  render(): ReactNode { return this.props.children; }
}
