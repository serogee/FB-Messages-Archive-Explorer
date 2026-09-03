export type TaskCompletion<Value> =
  | { status: 'completed'; value: Value }
  | { status: 'failed' }
  | { status: 'cancelled' };

type Subscriber<Value> = (completion: TaskCompletion<Value>) => void;

interface QueuedTask<Key, Value> {
  key: Key;
  state: 'queued' | 'running';
  controller: AbortController;
  subscribers: Set<Subscriber<Value>>;
}

/**
 * Bounds asynchronous work while allowing UI consumers to abandon queued work.
 * Running work is aborted on a best-effort basis; its slot is released when the
 * worker actually settles.
 */
export class SubscribableTaskQueue<Key, Value> {
  private readonly tasks = new Map<Key, QueuedTask<Key, Value>>();
  private readonly queue: Array<QueuedTask<Key, Value>> = [];
  private activeTasks = 0;
  private readonly maxConcurrentTasks: number;
  private readonly worker: (key: Key, signal: AbortSignal) => Promise<Value>;

  constructor(
    maxConcurrentTasks: number,
    worker: (key: Key, signal: AbortSignal) => Promise<Value>,
  ) {
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.worker = worker;
  }

  subscribe(key: Key, subscriber: Subscriber<Value>): () => void {
    let task = this.tasks.get(key);
    if (task?.controller.signal.aborted) task = undefined;

    if (!task) {
      task = {
        key,
        state: 'queued',
        controller: new AbortController(),
        subscribers: new Set(),
      };
      this.tasks.set(key, task);
      this.queue.push(task);
    } else if (task.state === 'queued') {
      this.promote(task);
    }

    task.subscribers.add(subscriber);
    this.drain();

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      task.subscribers.delete(subscriber);
      if (task.subscribers.size > 0) return;

      if (task.state === 'queued') this.removeQueued(task);
      task.controller.abort();
      if (this.tasks.get(key) === task) this.tasks.delete(key);
    };
  }

  clear(): void {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    this.queue.length = 0;

    for (const task of tasks) {
      task.controller.abort();
      this.notify(task, { status: 'cancelled' });
    }
  }

  private promote(task: QueuedTask<Key, Value>): void {
    const index = this.queue.indexOf(task);
    if (index <= 0) return;
    this.queue.splice(index, 1);
    this.queue.unshift(task);
  }

  private removeQueued(task: QueuedTask<Key, Value>): void {
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private drain(): void {
    while (this.activeTasks < this.maxConcurrentTasks) {
      const task = this.queue.shift();
      if (!task) return;
      if (task.subscribers.size === 0 || task.controller.signal.aborted) continue;

      task.state = 'running';
      this.activeTasks++;
      void this.run(task);
    }
  }

  private async run(task: QueuedTask<Key, Value>): Promise<void> {
    let completion: TaskCompletion<Value>;
    try {
      const value = await this.worker(task.key, task.controller.signal);
      completion = task.controller.signal.aborted
        ? { status: 'cancelled' }
        : { status: 'completed', value };
    } catch {
      completion = task.controller.signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failed' };
    }

    if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
    this.notify(task, completion);
    this.activeTasks--;
    this.drain();
  }

  private notify(task: QueuedTask<Key, Value>, completion: TaskCompletion<Value>): void {
    const subscribers = [...task.subscribers];
    task.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber(completion);
      } catch {
        // A consumer callback must not prevent cleanup or other notifications.
      }
    }
  }
}
