// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateNavigator } from '../src/components/Chat/DateNavigator';
import { ThreadDataContext } from '../src/hooks/useThreadData';
import type { Settings } from '../src/hooks/useSettings';
import type { MessengerMessage, MessengerThread } from '../src/types/messenger';

const settings = { autoCollapseDateNav: false } as Settings;
const message = (timestamp_ms: number): MessengerMessage => ({ sender_name: 'Owner', timestamp_ms, content: 'hello' });
const thread = (messages: MessengerMessage[]) => ({ title: 'chat', participants: [], messages } as unknown as MessengerThread);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('date navigator loaded-thread lifecycle', () => {
  it('preserves original jump indices and excludes notices when reading the shared thread', async () => {
    const jump = vi.fn().mockResolvedValue(undefined);
    const april = new Date(2024, 3, 8, 12).getTime(), may = new Date(2024, 4, 9, 12).getTime();
    const data = thread([
      { ...message(april), content: 'Alice reacted \u{1f602} to your message' },
      message(april + 1), message(may), message(may + 1),
    ]);
    const { container } = render(<ThreadDataContext value={data}><DateNavigator settings={settings} onJumpToMessage={jump} chatContainerRef={{ current: null }} /></ThreadDataContext>);
    await waitFor(() => expect(container.querySelectorAll('.date-nav-item')).toHaveLength(2));
    const buttons = container.querySelectorAll('.date-nav-item');
    expect(buttons[0].getAttribute('data-msg-index')).toBe('1');
    expect(buttons[0].textContent).toContain('1 msg');
    expect(buttons[1].textContent).toContain('2 msgs');
    fireEvent.click(buttons[1]);
    expect(jump).toHaveBeenCalledWith(2);
  });
  it('does not publish a previous chat after a pending calendar scan resumes', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 4));
    const oldData = thread(Array.from({ length: 2048 }, () => message(new Date(2023, 10, 1, 12).getTime())));
    const currentData = thread([message(new Date(2024, 3, 8, 12).getTime())]);
    const view = (data: MessengerThread) => <ThreadDataContext value={data}><DateNavigator settings={settings} onJumpToMessage={async () => {}} chatContainerRef={{ current: null }} /></ThreadDataContext>;
    const { container, rerender } = render(view(oldData));
    expect(container.querySelectorAll('.date-nav-item')).toHaveLength(0);
    await act(async () => { rerender(view(currentData)); });
    await act(async () => { await vi.runAllTimersAsync(); });
    const buttons = container.querySelectorAll('.date-nav-item');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('data-date-key')).toBe('2024-04');
  });
});
