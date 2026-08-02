import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatListEntry, MessengerThread, SearchIndexEntry, SearchResult } from '../types/messenger';
import { buildSearchIndex, performSearch } from '../services/search';
import { isReactionNoticeMessage } from '../services/reactions';
import { loadChatMessages } from '../services/fileSystem';

export function useSearch(
  chatData: MessengerThread | null,
  archiveList: ChatListEntry[]
): {
  query: string;
  setQuery: (q: string) => void;
  results: SearchResult[];
  isSearching: boolean;
  progress: number;
  isWideSearch: boolean;
  setIsWideSearch: (wide: boolean) => void;
  startSearch: () => Promise<void>;
  clearSearch: () => void;
} {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isWideSearch, setIsWideSearch] = useState(false);

  // Cache the narrow search index for the current chat
  const indexCacheRef = useRef<{ data: MessengerThread | null; index: SearchIndexEntry[] }>({
    data: null,
    index: [],
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  // Rebuild cache when chatData changes
  useEffect(() => {
    if (chatData !== indexCacheRef.current.data) {
      indexCacheRef.current = { data: chatData, index: [] }; // reset, build lazily on search
    }
  }, [chatData]);

  const startSearch = useCallback(async () => {
    if (!query.trim()) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

    setIsSearching(true);
    setProgress(0);
    setResults([]);

    try {
      if (!isWideSearch) {
        // Narrow search: current chat only
        if (!chatData?.messages) {
          setIsSearching(false);
          return;
        }
        // Build/reuse index
        if (indexCacheRef.current.data !== chatData || !indexCacheRef.current.index.length) {
          indexCacheRef.current = {
            data: chatData,
            index: buildSearchIndex(chatData.messages, isReactionNoticeMessage),
          };
        }
        if (signal.aborted) return;
        const found = await performSearch(query, indexCacheRef.current.index, setProgress, signal);
        if (signal.aborted) return;
        setResults(found);
      } else {
        // Wide search: all chats in archive
        const allResults: SearchResult[] = [];
        const total = archiveList.length;

        for (let i = 0; i < archiveList.length; i++) {
          if (signal.aborted) return;
          const entry = archiveList[i];
          try {
            const data = await loadChatMessages(entry.dirHandle);
            if (signal.aborted) return;
            const index = buildSearchIndex(data.messages, isReactionNoticeMessage);
            const found = await performSearch(query, index, undefined, signal);
            if (signal.aborted) return;
            // Annotate results with chat info
            found.forEach(r => {
              allResults.push({
                item: {
                  ...r.item,
                  chatTitle: entry.title,
                  chatFolderName: entry.folderName,
                },
              });
            });
          } catch (e: any) {
            if (e.name === 'AbortError') throw e;
          }
          if (signal.aborted) return;
          setProgress(Math.round(((i + 1) / total) * 100));
        }
        setResults(allResults);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        // Ignored, search aborted
        return;
      }
      console.error(e);
    } finally {
      if (!signal.aborted) {
        setIsSearching(false);
        setProgress(100);
      }
    }
  }, [query, isWideSearch, chatData, archiveList]);

  const clearSearch = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setQuery('');
    setResults([]);
    setProgress(0);
    setIsSearching(false);
  }, []);

  return { query, setQuery, results, isSearching, progress, isWideSearch, setIsWideSearch, startSearch, clearSearch };
}
