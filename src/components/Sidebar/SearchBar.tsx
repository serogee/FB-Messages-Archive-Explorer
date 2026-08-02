import { useRef } from 'react';
import type { useSearch } from '../../hooks/useSearch';
import { highlightText } from '../../services/search';
import { formatInfoDate } from '../../services/storage';

interface SearchBarProps {
  search: ReturnType<typeof useSearch>;
  onJumpToMessage?: (index: number) => void;
}

export function SearchBar({ search, onJumpToMessage }: SearchBarProps) {
  const { query, setQuery, results, isSearching, progress, isWideSearch, setIsWideSearch, startSearch, clearSearch } = search;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;
  const searchDone = !isSearching && hasQuery && (hasResults || progress >= 100);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') startSearch();
    if (e.key === 'Escape') clearSearch();
  };

  const handleResultClick = (msgIdx: number) => {
    if (onJumpToMessage) onJumpToMessage(msgIdx);
  };

  return (
    <div className="sidebar-search" ref={wrapRef}>
      {/* Input row */}
      <div className="sidebar-search-row">
        <input
          ref={inputRef}
          className="sidebar-search-input"
          type="search"
          placeholder={isWideSearch ? 'Search all chats...' : 'Search current chat...'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search messages"
          id="sidebarSearchInput"
        />
        <button
          className={`sidebar-scope-btn${isWideSearch ? ' active' : ''}`}
          onClick={() => setIsWideSearch(!isWideSearch)}
          title={isWideSearch ? 'Searching all chats — click to search current chat only' : 'Searching current chat — click to search all chats'}
          aria-label="Toggle search scope"
          aria-pressed={isWideSearch}
        >
          {isWideSearch ? 'All' : 'Chat'}
        </button>
        {hasQuery && (
          <button
            className="sidebar-clear-btn"
            onClick={clearSearch}
            aria-label="Clear search"
            title="Clear search"
          >
            X
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className={`sidebar-search-progress${isSearching ? '' : ' hidden'}`}>
        <div className="sidebar-search-progress-bar">
          <div className="sidebar-search-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="sidebar-search-progress-text">{progress < 100 ? `${progress}%` : 'Done'}</span>
      </div>

      {/* Results overlay */}
      {searchDone && (
        <div className="sidebar-search-results" role="listbox" aria-label="Search results">
          {results.length === 0 ? (
            <div className="search-result-item search-no-results">
              No results found{isWideSearch ? ' in any chat' : ' in current chat'}.
            </div>
          ) : (
            results.slice(0, 50).map((r, i) => {
              const snippet = r.item.text.slice(0, 200);
              const highlighted = highlightText(snippet, query);
              const time = formatInfoDate(r.item.timestamp);
              return (
                <div
                  key={i}
                  className="search-result-item"
                  role="option"
                  aria-selected={false}
                  data-msg-idx={r.item.idx}
                  data-chat-folder={r.item.chatFolderName}
                  tabIndex={0}
                  onClick={() => handleResultClick(r.item.idx)}
                  onKeyDown={e => { if (e.key === 'Enter') handleResultClick(r.item.idx); }}
                >
                  <div className="snippet" dangerouslySetInnerHTML={{ __html: highlighted }} />
                  <div className="meta">
                    {r.item.sender} · {time}
                  </div>
                  {r.item.chatTitle && (
                    <div className="meta">
                      {r.item.chatTitle}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
