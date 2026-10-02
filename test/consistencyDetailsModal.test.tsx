// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConsistencyDetailsModal } from '../src/components/Modals/ConsistencyDetailsModal';
import type { ChatListEntry } from '../src/types/messenger';

afterEach(cleanup);

it('shows failed chats in chat-list format and opens the selected chat', () => {
  const chat = {
    folderName: 'alice_123', title: 'Alice', participants: ['Owner', 'Alice'], lastMessage: 'Last message', lastTimestamp: Date.now(),
    messageCount: 20, folderSize: 1024, jsonFileCount: 1, source: 'inbox', dirHandle: { kind: 'directory', name: 'alice_123' },
  } as ChatListEntry;
  const onOpenChat = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<ConsistencyDetailsModal chats={[{ entry: chat, issue: { id: 'inbox:alice_123', notices: 20, candidates: 18 } }]} onOpenChat={onOpenChat} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Chats with inconsistent matches' })).toBeTruthy();
  expect(screen.getByText('18/20 notices match reactions')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onOpenChat).toHaveBeenCalledWith(chat);
});

it('uses the supplied title for the all-unmatched list', () => {
  const chat = { folderName: 'alice_123', title: 'Alice', participants: ['Owner', 'Alice'], messageCount: 2, folderSize: 1, jsonFileCount: 1, source: 'inbox', dirHandle: { kind: 'directory', name: 'alice_123' } } as ChatListEntry;
  render(<ConsistencyDetailsModal title="Chats with unmatched notices" chats={[{ entry: chat, issue: { id: 'inbox:alice_123', notices: 2, candidates: 1 } }]} onOpenChat={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Chats with unmatched notices' })).toBeTruthy();
  expect(screen.getByText('1/2 notices match reactions')).toBeTruthy();
});
