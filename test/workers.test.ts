import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('parser worker protocols', () => {
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
