// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ReactionNoticesInfoModal } from '../src/components/Modals/ReactionNoticesInfoModal';

it('explains notices, reactions, matches, and consistency in the info modal', () => {
  const onClose = vi.fn();
  render(<ReactionNoticesInfoModal onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Reaction notices' })).toBeTruthy();
  expect(screen.getByText('A reaction notice is a message that reports a reaction.')).toBeTruthy();
  expect(screen.getByText('A text message, for example: “Alex reacted ❤️ to your message”.')).toBeTruthy();
  expect(screen.getByText('An emoji attached to a message, for example: ❤️ by Alex.')).toBeTruthy();
  expect(screen.getByText('Match notices and reactions in the same activity block.')).toBeTruthy();
  expect(screen.getByText('Also match notices and reactions in older activity blocks.')).toBeTruthy();
  expect(screen.getByText('Mark a strict or nearby match. Example: ~ Jan 15, 2024, 10:30 AM.')).toBeTruthy();
  expect(screen.getByText('Mark a match in an older activity block. Example: ~~ Jan 15, 2024, 10:30 AM.')).toBeTruthy();
  expect(screen.getByText('Show the percentage of supported notices that match reactions.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close reaction notices information' }));
  expect(onClose).toHaveBeenCalledOnce();
});
