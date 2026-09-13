// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchBar } from '../src/components/Sidebar/SearchBar';
import type { useSearch } from '../src/hooks/useSearch';

describe('SearchBar', () => {
  it('limits rendered results and jumps to the keyboard-selected message and chat', () => {
    const startSearch = vi.fn();
    const onJumpToMessage = vi.fn();
    const search = {
      activeQuery: 'needle',
      results: Array.from({ length: 60 }, (_, index) => ({
        item: {
          text: `needle ${index}`,
          normalized: `needle ${index}`,
          sender: 'Alice',
          timestamp: index,
          idx: 100 + index,
          chatTitle: `Chat ${index}`,
          chatFolderName: `chat-${index}`,
        },
      })),
      isSearching: false,
      progress: 100,
      isWideSearch: true,
      setIsWideSearch: vi.fn(),
      startSearch,
      clearSearch: vi.fn(),
      clearWideSearchCache: vi.fn(),
    } as ReturnType<typeof useSearch>;
    render(<SearchBar search={search} onJumpToMessage={onJumpToMessage} />);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(50);
    fireEvent.keyDown(options[12], { key: 'Enter' });
    expect(onJumpToMessage).toHaveBeenCalledWith(112, 'chat-12');
    expect(options[12].getAttribute('aria-selected')).toBe('true');

    const input = screen.getByRole('searchbox', { name: 'Search messages' });
    fireEvent.change(input, { target: { value: 'next query' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(startSearch).toHaveBeenCalledWith('next query');
  });
});
