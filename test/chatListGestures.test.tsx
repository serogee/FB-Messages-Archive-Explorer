// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatList } from '../src/components/Sidebar/ChatList';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const entry: ChatListEntry = {
  folderName: 'alice', title: 'Alice Chat', source: 'inbox', participants: ['Alice'], messageCount: 2,
  folderSize: 10, jsonFileCount: 1,
  dirHandle: createMockDirectoryHandle('alice', { 'message_1.json': '{}' }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', undefined);
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'touch';
      this.isPrimary = init.isPrimary ?? true;
    }
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const props = { chatList: [entry], activeEntry: null, onSelectChat: vi.fn().mockResolvedValue(undefined),
    onDeleteChat: vi.fn(), deletionEnabled: true, bookmarkingEnabled: true, onToggleChatPin: vi.fn().mockResolvedValue(undefined) };
  const view = render(<ChatList {...props} />);
  const row = view.container.querySelector<HTMLElement>('.chat-list-item')!;
  return { props, view, row };
}

const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 100 };
async function hold(row: HTMLElement) {
  fireEvent.pointerDown(row, pointer);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

describe('mobile chat-list options', () => {
  it('opens a chat on a short tap and omits the mobile menu button', async () => {
    const { row, props } = setup();
    expect(screen.queryByRole('button', { name: 'Chat options' })).toBeNull();
    fireEvent.pointerDown(row, pointer);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    fireEvent.pointerUp(row, pointer);
    await act(async () => { fireEvent.click(row, { detail: 1 }); });
    expect(props.onSelectChat).toHaveBeenCalledExactlyOnceWith(entry);
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
  });

  it('opens the existing options after holding and suppresses the native context menu and release click', async () => {
    const { row, props } = setup();
    await hold(row);
    expect(screen.getByRole('button', { name: 'Pin to top' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open JSON' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy folder path' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete chat' })).toBeTruthy();
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row, context);
    expect(context.defaultPrevented).toBe(true);
    fireEvent.pointerUp(row, pointer);
    fireEvent.click(row, { detail: 1 });
    expect(props.onSelectChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pin to top' }));
    expect(props.onToggleChatPin).toHaveBeenCalledExactlyOnceWith(entry);
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it.each(['move', 'scroll', 'cancel', 'second touch'])('cancels a hold on %s without opening a chat or menu', async kind => {
    const { row, props } = setup();
    fireEvent.pointerDown(row, pointer);
    if (kind === 'move') fireEvent.pointerMove(row, { ...pointer, clientY: 135 });
    if (kind === 'scroll') fireEvent.scroll(window);
    if (kind === 'cancel') fireEvent.pointerCancel(row, pointer);
    if (kind === 'second touch') fireEvent.pointerDown(document.body, { ...pointer, pointerId: 2, isPrimary: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    fireEvent.pointerUp(row, pointer);
    fireEvent.click(row, { detail: 1 });
    expect(props.onSelectChat).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
  });

  it('cancels pending holds and closes open options when the list becomes hidden', async () => {
    const { row, props, view } = setup();
    fireEvent.pointerDown(row, pointer);
    view.rerender(<ChatList {...props} hidden />);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
    view.rerender(<ChatList {...props} />);
    await hold(row);
    expect(screen.getByRole('button', { name: 'Pin to top' })).toBeTruthy();
    view.rerender(<ChatList {...props} hidden />);
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
  });

  it('keeps selection mode available without opening options on a hold', async () => {
    const { row, props, view } = setup();
    const onToggleSelectChat = vi.fn();
    view.rerender(<ChatList {...props} selectionMode onToggleSelectChat={onToggleSelectChat} />);
    await hold(row);
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
    fireEvent.click(row);
    expect(onToggleSelectChat).toHaveBeenCalledTimes(1);
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it('supports keyboard options and Escape without opening the chat', async () => {
    const { row, props } = setup();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    await act(async () => {});
    const pin = screen.getByRole('button', { name: 'Pin to top' });
    fireEvent.keyDown(pin, { key: 'Enter' });
    expect(props.onSelectChat).not.toHaveBeenCalled();
    fireEvent.keyDown(pin, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('retains the desktop menu button and ignores desktop touch holds', async () => {
    vi.stubGlobal('innerWidth', 1280);
    const { row, props } = setup();
    await hold(row);
    expect(screen.queryByRole('button', { name: 'Pin to top' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pin to top' })).toBeTruthy();
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it.each(['tap', 'keyboard'])('keeps the preview unchanged for a pending chat opened by %s', async input => {
    const { row, props } = setup();
    const preview = row.querySelector('.chat-item-preview')!.textContent;
    let finish!: () => void;
    props.onSelectChat.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    if (input === 'tap') fireEvent.click(row);
    else fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.classList.contains('active')).toBe(true);
    expect(row.querySelector('.chat-item-preview')!.textContent).toBe(preview);
    expect(row.querySelector('.loading-spinner')).toBeNull();
    expect(row.textContent).not.toContain('Loading chat');
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { finish(); });
    expect(row.hasAttribute('aria-busy')).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(row.textContent).toContain('No messages');
  });

  it('keeps feedback on the latest selection when an earlier request finishes', async () => {
    const { props, view } = setup();
    const bob = { ...entry, folderName: 'bob', title: 'Bob Chat' };
    let finishAlice!: () => void;
    let finishBob!: () => void;
    props.onSelectChat
      .mockReturnValueOnce(new Promise<void>(resolve => { finishAlice = resolve; }))
      .mockReturnValueOnce(new Promise<void>(resolve => { finishBob = resolve; }));
    view.rerender(<ChatList {...props} chatList={[entry, bob]} />);
    const aliceRow = screen.getByRole('button', { name: /Alice Chat/ });
    const bobRow = screen.getByRole('button', { name: /Bob Chat/ });
    fireEvent.click(aliceRow);
    fireEvent.click(bobRow);
    expect(aliceRow.hasAttribute('aria-busy')).toBe(false);
    expect(bobRow.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finishAlice(); });
    expect(bobRow.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finishBob(); });
    expect(bobRow.hasAttribute('aria-busy')).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
