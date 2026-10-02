import { expect, it } from 'vitest';
import { displayReactionEmoji } from '../src/services/reactions';

it('renders legacy text hearts as red-heart emoji', () => {
  expect(displayReactionEmoji('❤')).toBe('❤️');
  expect(displayReactionEmoji('❤️')).toBe('❤️');
});
