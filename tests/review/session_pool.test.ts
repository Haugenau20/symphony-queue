import { describe, expect, it, vi } from 'vitest'
import { ReviewSessionPool } from '../../src/review/session_pool.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('ReviewSessionPool', () => {
  it('rejects invalid concurrency limits', () => {
    expect(() => new ReviewSessionPool(0)).toThrow(RangeError)
    expect(() => new ReviewSessionPool(-1)).toThrow(RangeError)
    expect(() => new ReviewSessionPool(1.5)).toThrow(RangeError)
    expect(() => new ReviewSessionPool(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })

  it('never starts more than maxConcurrency tasks', async () => {
    const pool = new ReviewSessionPool(2)
    const first = deferred<string>()
    const second = deferred<string>()
    const third = deferred<string>()
    const started: string[] = []

    const p1 = pool.run('mr-1', signal(), async () => {
      started.push('one')
      return first.promise
    })
    const p2 = pool.run('mr-2', signal(), async () => {
      started.push('two')
      return second.promise
    })
    const p3 = pool.run('mr-3', signal(), async () => {
      started.push('three')
      return third.promise
    })

    expect(started).toEqual(['one', 'two'])
    expect(pool.runningCount).toBe(2)
    expect(pool.queuedCount).toBe(1)

    first.resolve('first')
    await expect(p1).resolves.toBe('first')
    expect(started).toEqual(['one', 'two', 'three'])
    expect(pool.runningCount).toBe(2)

    second.resolve('second')
    third.resolve('third')
    await expect(Promise.all([p2, p3])).resolves.toEqual(['second', 'third'])
    expect(pool.runningCount).toBe(0)
    expect(pool.queuedCount).toBe(0)
  })

  it('dispatches queued work round-robin across review keys and FIFO within each key', async () => {
    const pool = new ReviewSessionPool(1)
    const blocker = deferred<void>()
    const releases = new Map<string, Deferred<void>>()
    const completions = new Map<string, Promise<void>>()
    const started: string[] = []

    const first = pool.run('blocker', signal(), () => blocker.promise)
    const schedule = (key: string, label: string) => {
      const release = deferred<void>()
      releases.set(label, release)
      const completion = pool.run(key, signal(), async () => {
        started.push(label)
        return release.promise
      })
      completions.set(label, completion)
      return completion
    }

    const a1 = schedule('mr-a', 'a1')
    const a2 = schedule('mr-a', 'a2')
    const b1 = schedule('mr-b', 'b1')
    const c1 = schedule('mr-c', 'c1')
    const b2 = schedule('mr-b', 'b2')

    blocker.resolve()
    await first
    expect(started).toEqual(['a1'])

    for (const label of ['a1', 'b1', 'c1', 'a2', 'b2']) {
      releases.get(label)?.resolve()
      await completions.get(label)
    }

    await Promise.all([a1, a2, b1, b2, c1])
    expect(started).toEqual(['a1', 'b1', 'c1', 'a2', 'b2'])
  })

  it('removes and rejects aborted queued work without starting it', async () => {
    const pool = new ReviewSessionPool(1)
    const blocker = deferred<void>()
    const first = pool.run('mr-a', signal(), () => blocker.promise)
    const controller = new AbortController()
    const task = vi.fn(async () => 'should not run')
    const reason = new Error('review superseded')

    const queued = pool.run('mr-b', controller.signal, task)
    expect(pool.queuedCount).toBe(1)
    expect(pool.queuedCountFor('mr-b')).toBe(1)

    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(task).not.toHaveBeenCalled()
    expect(pool.queuedCount).toBe(0)
    expect(pool.queuedCountFor('mr-b')).toBe(0)

    blocker.resolve()
    await first
  })

  it('does not invoke a task whose signal was already aborted', async () => {
    const pool = new ReviewSessionPool(1)
    const controller = new AbortController()
    const reason = new Error('shutdown')
    const task = vi.fn(async () => 'no')
    controller.abort(reason)

    await expect(pool.run('mr-a', controller.signal, task)).rejects.toBe(reason)
    expect(task).not.toHaveBeenCalled()
    expect(pool.runningCount).toBe(0)
    expect(pool.queuedCount).toBe(0)
  })

  it('accepts work without a cancellation signal', async () => {
    const pool = new ReviewSessionPool(1)
    await expect(pool.run('critic', undefined, async () => 'critiqued')).resolves.toBe('critiqued')
    expect(pool.runningCount).toBe(0)
  })

  it('releases a slot when a task rejects and starts the next queued task', async () => {
    const pool = new ReviewSessionPool(1)
    const failure = deferred<void>()
    const started: string[] = []

    const first = pool.run('mr-a', signal(), async () => {
      started.push('first')
      return failure.promise
    })
    const second = pool.run('mr-b', signal(), async () => {
      started.push('second')
      return 'ok'
    })

    const error = new Error('agent failed')
    failure.reject(error)
    await expect(first).rejects.toBe(error)
    await expect(second).resolves.toBe('ok')
    expect(started).toEqual(['first', 'second'])
    expect(pool.runningCount).toBe(0)
  })

  it('releases a slot when a task throws synchronously', async () => {
    const pool = new ReviewSessionPool(1)
    const error = new Error('sync failure')
    const first = pool.run('mr-a', signal(), (() => {
      throw error
    }) as () => Promise<never>)
    const second = pool.run('mr-b', signal(), async () => 'ok')

    await expect(first).rejects.toBe(error)
    await expect(second).resolves.toBe('ok')
    expect(pool.runningCount).toBe(0)
  })

  it('keeps a running aborted task in its slot until the underlying operation settles', async () => {
    const pool = new ReviewSessionPool(1)
    const controller = new AbortController()
    const running = deferred<void>()
    const nextStarted = vi.fn()

    const first = pool.run('mr-a', controller.signal, () => running.promise)
    const second = pool.run('mr-b', signal(), async () => {
      nextStarted()
      return 'next'
    })

    controller.abort(new Error('superseded'))
    expect(nextStarted).not.toHaveBeenCalled()
    expect(pool.runningCount).toBe(1)

    running.resolve()
    await first
    await expect(second).resolves.toBe('next')
    expect(nextStarted).toHaveBeenCalledTimes(1)
  })
})
