import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('parser worker protocols', () => {
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
