import { createContext, useContext } from 'react';
import type { MessengerThread } from '../types/messenger';

// Share the loaded thread without repeating its complete message history in
// component props (which React's development tracing expands on every commit).
export const ThreadDataContext = createContext<MessengerThread | null>(null);

export function useThreadData(override?: MessengerThread | null): MessengerThread | null {
  const current = useContext(ThreadDataContext);
  return override === undefined ? current : override;
}
