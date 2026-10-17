import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('parser worker protocols', () => {
  it('applies concurrency messages during parsing without restarting or posting extra results', async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null as ((event: MessageEvent) => Promise<void>) | null, postMessage };
    vi.stubGlobal('self', scope);
    await import('../src/services/parserWorker');
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const files = Array.from({ length: 5 }, (_, index) => {
      const gate = new Promise<void>(resolve => releases.push(resolve));
      return { text: async () => { started.push(index); await gate; return JSON.stringify({ participants: [], messages: [{ content: `${index}`, timestamp_ms: index + 1 }] }); } } as File;
    });
    const pending = scope.onmessage!({ data: { files, concurrency: 1 } } as MessageEvent);
    expect(started).toEqual([0]);
    await scope.onmessage!({ data: { type: 'concurrency', concurrency: 3 } } as MessageEvent);
    expect(started).toEqual([0, 1, 2]);
    await scope.onmessage!({ data: { type: 'concurrency', concurrency: 1 } } as MessageEvent);
    releases[0](); releases[1]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.forEach(release => release());
    await pending;
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0].data.messages.map((message: { content: string }) => message.content)).toEqual(['0', '1', '2', '3', '4']);
  });
  it('reads four texts concurrently and preserves equal-time messages and participant order', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const started: number[] = [];
    const files = Array.from({ length: 6 }, (_, index) => {
      const gate = new Promise<void>(resolve => { releases.push(resolve); });
      return { text: async () => {
        started.push(index);
        active++;
        peak = Math.max(peak, active);
        try {
          await gate;
          return JSON.stringify({ title: `Part ${index}`, participants: [{ name: `Person ${index}` }],
            messages: [{ content: `Message ${index}`, timestamp_ms: 1 }] });
        } finally { active--; }
      } } as File;
    });
    const pending = workerScope.onmessage!({ data: { files } } as MessageEvent<{ files: File[] }>);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3]();
    await vi.waitFor(() => expect(started).toContain(4));
    releases[4]();
    await vi.waitFor(() => expect(started).toContain(5));
    expect(postMessage).not.toHaveBeenCalled();
    releases.forEach(release => release());
    await pending;
    expect(peak).toBe(4);
    const envelope = postMessage.mock.calls[0][0];
    expect(envelope).toMatchObject({ type: 'success', complete: true, data: { title: 'Part 0' } });
    expect(envelope.data.messages.map((message: { content: string }) => message.content))
      .toEqual(files.map((_, index) => `Message ${index}`));
    expect(envelope.data.participants).toEqual(files.map((_, index) => ({ name: `Person ${index}` })));
  });

  it('shows readable parts while marking skipped unreadable or invalid parts incomplete', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');
    const valid = new File([JSON.stringify({ participants: [], messages: [{ content: 'readable', timestamp_ms: 1 }] })], 'message_1.json');
    const unreadable = { text: () => Promise.reject(new Error('Permission revoked')) } as File;
    const files = [valid, new File(['{'], 'message_2.json'), new File(['{"messages":{}}'], 'message_3.json'), unreadable];
    await workerScope.onmessage!({ data: { files } } as MessageEvent<{ files: File[] }>);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'success', complete: false, data: { messages: [{ content: 'readable' }] } });
  });

  it('keeps first-readable metadata and stable undated messages across parts', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');
    const undatedFirst = { content: 'undated first' };
    const undatedZero = { content: 'undated zero', timestamp_ms: 0, timestamp: 99 };
    const equalFirst = { content: 'equal first', timestamp_ms: 10 };
    const equalSecond = { content: 'equal second', timestamp_ms: 10 };
    const earlier = { content: 'earlier', timestamp: 1 };
    const undatedSecond = { content: 'undated second', timestamp_ms: -1 };
    const files = [
      { text: () => Promise.reject(new Error('Permission revoked')) } as File,
      new File([JSON.stringify({
        title: 'First readable', thread_path: 'inbox/first', is_still_participant: true,
        participants: [{ name: 'Alice' }, { name: 'Bob' }],
        messages: [undatedZero, equalFirst, undatedFirst],
      })], 'message_2.json'),
      new File([JSON.stringify({
        title: 'Later part', thread_path: 'inbox/later', is_still_participant: false,
        participants: [{ name: 'Bob' }, { name: 'Cara' }, { name: 'Alice' }],
        messages: [undatedSecond, equalSecond, earlier],
      })], 'message_1.json'),
    ];

    await workerScope.onmessage!({ data: { files } } as MessageEvent<{ files: File[] }>);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toEqual({
      type: 'success', complete: false,
      data: {
        title: 'First readable', thread_path: 'inbox/first', is_still_participant: true,
        participants: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Cara' }],
        messages: [earlier, equalFirst, equalSecond, undatedFirst, undatedZero, undatedSecond],
      },
    });
  });

  it('preserves production file/part order for equal-time messages', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');
    const { getOrderedMessageFileNames, parseMessengerJsonContent, mergeMessengerData, normalizeMessengerData } = await import('../src/services/parser');
    const texts = new Map(['message_1.json', 'message_2.json'].map(name => [name, JSON.stringify({
      thread_path: 'inbox/test', participants: [], messages: [{ content: `${name}-newer`, timestamp_ms: 1 }, { content: `${name}-older`, timestamp_ms: 1 }],
    })]));
    const names = getOrderedMessageFileNames([...texts.keys()]);
    const files = names.map(name => new File([texts.get(name)!], name));
    const expected = normalizeMessengerData(mergeMessengerData(names.map(name => parseMessengerJsonContent(texts.get(name)!))));
    await workerScope.onmessage!({ data: { files } } as MessageEvent<{ files: File[] }>);
    expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'success', complete: true, data: expected });
    expect(postMessage.mock.calls[0][0].data.messages.map((m: { content: string }) => m.content)).toEqual(['message_2.json-older', 'message_2.json-newer', 'message_1.json-older', 'message_1.json-newer']);
  });

  it('merges Facebook parts chronologically and posts a serializable success envelope', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');

    const files = [
      new File([JSON.stringify({
        title: 'Chat', thread_path: 'inbox/chat', participants: [{ name: 'Alice' }],
        messages: [{ sender_name: 'Alice', timestamp_ms: 30, content: 'later' }],
      })], 'message_1.json'),
      new File([JSON.stringify({
        title: 'Chat', thread_path: 'inbox/chat', participants: [{ name: 'Bob' }, { name: 'Alice' }],
        messages: [{ sender_name: 'Bob', timestamp_ms: 10, content: 'earlier' }],
      })], 'message_2.json'),
    ];

    await workerScope.onmessage!({ data: { files } } as MessageEvent<{ files: File[] }>);

    expect(postMessage).toHaveBeenCalledOnce();
    const envelope = postMessage.mock.calls[0][0];
    expect(envelope.type).toBe('success');
    expect(envelope.data.messages.map((message: { content: string }) => message.content)).toEqual(['earlier', 'later']);
    expect(envelope.data.participants).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    expect(() => structuredClone(envelope)).not.toThrow();
  });

  it('posts an error envelope for empty input and invalid Facebook JSON', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ files: File[] }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/parserWorker');

    await workerScope.onmessage!({ data: { files: [] } } as MessageEvent<{ files: File[] }>);
    await workerScope.onmessage!({ data: { files: [new File(['{'], 'message_1.json') ] } } as MessageEvent<{ files: File[] }>);

    expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual(['error', 'error']);
    expect(postMessage.mock.calls[0][0].error).toBe('No files provided');
    expect(postMessage.mock.calls[1][0].error).toMatch(/JSON/i);
  });

  it('posts Messenger success and parse-error envelopes', async () => {
    const postMessage = vi.fn();
    const workerScope: { onmessage?: (event: MessageEvent<{ file: File }>) => Promise<void>; postMessage: typeof postMessage } = { postMessage };
    vi.stubGlobal('self', workerScope);
    await import('../src/services/messengerExport/messengerExportWorker');

    await workerScope.onmessage!({ data: { file: new File([JSON.stringify({
      threadName: 'Alice', participants: ['Alice'],
      messages: [{ senderName: 'Alice', text: 'hello', timestamp: 1 }],
    })], 'alice.json') } } as MessageEvent<{ file: File }>);
    await workerScope.onmessage!({ data: { file: new File(['{'], 'broken.json') } } as MessageEvent<{ file: File }>);

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: 'success',
      data: { title: 'Alice', participants: [{ name: 'Alice' }] },
    });
    expect(postMessage.mock.calls[1][0].type).toBe('error');
    expect(postMessage.mock.calls[1][0].error).toMatch(/JSON/i);
  });
});
