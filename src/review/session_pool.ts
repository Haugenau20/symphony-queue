/**
 * A global, bounded scheduler for review-agent and critic sessions.
 *
 * Work is FIFO within a review key and round-robin across review keys. This
 * prevents one large merge request from draining its entire backlog before a
 * smaller, already-queued review gets a turn.
 *
 * Cancellation has deliberately different semantics depending on whether a
 * task has started. Queued work is removed and rejected immediately. Running
 * work keeps its slot until the supplied task settles; releasing it earlier
 * would allow the pool to exceed its real concurrency ceiling when a task
 * ignores its AbortSignal. The caller is responsible for passing the same
 * signal to the underlying agent operation so running cancellation settles
 * promptly.
 */

interface QueuedSession {
  readonly signal: AbortSignal | undefined
  readonly task: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
  readonly onAbort: () => void
  state: 'queued' | 'running' | 'settled'
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

export class ReviewSessionPool {
  readonly maxConcurrency: number

  private running = 0
  private queued = 0
  private draining = false
  private readonly queues = new Map<string, QueuedSession[]>()
  /** Every work key with queued entries occurs exactly once in this array. */
  private readonly readyKeys: string[] = []

  constructor(maxConcurrency: number) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new RangeError('maxConcurrency must be a positive safe integer')
    }
    this.maxConcurrency = maxConcurrency
  }

  get runningCount(): number {
    return this.running
  }

  get queuedCount(): number {
    return this.queued
  }

  queuedCountFor(workKey: string): number {
    return this.queues.get(workKey)?.length ?? 0
  }

  /**
   * Schedule one session. The promise adopts the task's result or error.
   *
   * The task should use the supplied signal for its underlying work. The pool
   * watches it directly while queued, but cannot safely force a running async
   * operation to stop.
   */
  run<T>(workKey: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedSession = {
        signal,
        task,
        // The task and resolver originate from the same run<T>() call, so the
        // value that settles the task is the T accepted by this resolver.
        resolve: (value) => resolve(value as T),
        reject,
        state: 'queued',
        onAbort: () => this.abortQueued(workKey, entry),
      }

      const queue = this.queues.get(workKey)
      if (queue) {
        queue.push(entry)
      } else {
        this.queues.set(workKey, [entry])
        this.readyKeys.push(workKey)
      }
      this.queued++
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.drain()
    })
  }

  private abortQueued(workKey: string, entry: QueuedSession): void {
    if (entry.state !== 'queued') return

    const queue = this.queues.get(workKey)
    if (!queue) return
    const index = queue.indexOf(entry)
    if (index === -1) return

    queue.splice(index, 1)
    this.queued--
    entry.state = 'settled'
    entry.signal?.removeEventListener('abort', entry.onAbort)

    if (queue.length === 0) {
      this.queues.delete(workKey)
      const readyIndex = this.readyKeys.indexOf(workKey)
      if (readyIndex !== -1) this.readyKeys.splice(readyIndex, 1)
    }

    // This callback can only run when the entry has a signal.
    entry.reject(abortReason(entry.signal!))
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      while (this.running < this.maxConcurrency && this.readyKeys.length > 0) {
        const workKey = this.readyKeys.shift()
        if (workKey === undefined) return

        const queue = this.queues.get(workKey)
        const entry = queue?.shift()
        if (!queue || !entry) {
          this.queues.delete(workKey)
          continue
        }

        if (queue.length > 0) {
          this.readyKeys.push(workKey)
        } else {
          this.queues.delete(workKey)
        }

        this.queued--
        this.running++
        entry.state = 'running'
        entry.signal?.removeEventListener('abort', entry.onAbort)
        this.start(entry)
      }
    } finally {
      this.draining = false
    }
  }

  private start(entry: QueuedSession): void {
    let result: Promise<unknown>
    try {
      result = entry.task()
    } catch (error) {
      this.finish(entry, false, error)
      return
    }

    void Promise.resolve(result).then(
      (value) => this.finish(entry, true, value),
      (error: unknown) => this.finish(entry, false, error),
    )
  }

  private finish(entry: QueuedSession, succeeded: boolean, value: unknown): void {
    if (entry.state !== 'running') return
    entry.state = 'settled'
    this.running--

    if (succeeded) entry.resolve(value)
    else entry.reject(value)

    this.drain()
  }
}
