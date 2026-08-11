import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ReviewController,
  buildRoundRobinQueue,
  classifySkipReason,
  type ReviewWorker,
} from '../../src/review/controller.js'
import { ConcurrencyGate } from '../../src/concurrency.js'
import type {
  MergeRequestClient,
  MergeRequestDiffFile,
  MergeRequestSummary,
  ReviewJob,
  ReviewJobKey,
  ReviewStore,
} from '../../src/review/types.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function keyString(key: ReviewJobKey): string {
  return `${key.projectId}::${key.mrIid}::${key.headSha}`
}

class FakeReviewStore implements ReviewStore {
  records = new Map<string, ReviewJob>()
  cursor: Date | null = null
  claimFailKeys = new Set<string>()
  claimCalls: ReviewJobKey[] = []
  recoverJobs: ReviewJob[] = []
  listClaimableCalls = 0

  seed(job: ReviewJob): void {
    this.records.set(keyString(job.key), job)
  }

  async get(key: ReviewJobKey): Promise<ReviewJob | null> {
    return this.records.get(keyString(key)) ?? null
  }

  async put(job: ReviewJob): Promise<void> {
    this.records.set(keyString(job.key), job)
  }

  async update(job: ReviewJob): Promise<void> {
    this.records.set(keyString(job.key), job)
  }

  async claim(key: ReviewJobKey): Promise<boolean> {
    this.claimCalls.push(key)
    const ks = keyString(key)
    if (this.claimFailKeys.has(ks)) return false
    const existing = this.records.get(ks)
    if (!existing || existing.state === 'claimed') return false
    this.records.set(ks, { ...existing, state: 'claimed' })
    return true
  }

  async listClaimable(_now: Date): Promise<ReviewJob[]> {
    this.listClaimableCalls++
    return Array.from(this.records.values()).filter((j) => j.state === 'discovered')
  }

  async recoverInFlight(): Promise<ReviewJob[]> {
    return this.recoverJobs
  }

  async readCursor(): Promise<Date | null> {
    return this.cursor
  }

  async writeCursor(at: Date): Promise<void> {
    this.cursor = at
  }
}

class FakeClient implements MergeRequestClient {
  calls: Array<{ updatedAfter: Date | null }> = []
  private impl: (opts: { updatedAfter: Date | null }) => Promise<MergeRequestSummary[]>

  constructor(impl: (opts: { updatedAfter: Date | null }) => Promise<MergeRequestSummary[]>) {
    this.impl = impl
  }

  async listOpenMergeRequests(opts: { updatedAfter: Date | null }): Promise<MergeRequestSummary[]> {
    this.calls.push(opts)
    return this.impl(opts)
  }

  async getMergeRequest(): Promise<MergeRequestSummary | null> {
    throw new Error('not used by controller tests')
  }

  async listDiffs(): Promise<MergeRequestDiffFile[]> {
    throw new Error('not used by controller tests')
  }

  async getFileAtRef(): Promise<string | null> {
    throw new Error('not used by controller tests')
  }

  async listNotes(): Promise<Array<{ id: string; body: string }>> {
    throw new Error('not used by controller tests')
  }

  async createNote(): Promise<string> {
    throw new Error('not used by controller tests')
  }
}

class FakeWorker implements ReviewWorker {
  calls: Array<{ job: ReviewJob; signal: AbortSignal }> = []
  dispatchOrder: string[] = []
  /** When true, runJob never resolves on its own — the test controls completion via resolveOne/resolveAll. */
  pending = false
  private resolvers = new Map<string, () => void>()

  async runJob(job: ReviewJob, signal: AbortSignal): Promise<void> {
    this.calls.push({ job, signal })
    this.dispatchOrder.push(`${job.key.projectId}#${job.key.mrIid}`)
    if (this.pending) {
      await new Promise<void>((resolve) => this.resolvers.set(keyString(job.key), resolve))
    }
  }

  resolveOne(key: ReviewJobKey): void {
    const r = this.resolvers.get(keyString(key))
    r?.()
    this.resolvers.delete(keyString(key))
  }

  resolveAll(): void {
    for (const r of this.resolvers.values()) r()
    this.resolvers.clear()
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let discoveredCounter = 0

function summary(overrides: Partial<MergeRequestSummary> = {}): MergeRequestSummary {
  return {
    projectId: 'my-org/service-a',
    mrIid: 1,
    headSha: 'sha-' + Math.random().toString(36).slice(2),
    baseSha: 'base',
    startSha: 'base',
    title: 'A change',
    description: null,
    draft: false,
    isFork: false,
    state: 'opened',
    webUrl: null,
    updatedAt: new Date('2026-08-10T09:00:00.000Z'),
    ...overrides,
  }
}

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  discoveredCounter += 1
  const key: ReviewJobKey = overrides.key ?? {
    projectId: 'my-org/service-a',
    mrIid: discoveredCounter,
    headSha: `sha-${discoveredCounter}`,
  }
  return {
    key,
    baseSha: 'base',
    startSha: 'base',
    title: 'A change',
    webUrl: null,
    state: 'discovered',
    attempts: 0,
    nextRetryAt: null,
    discoveredAt: new Date(2026, 7, 10, 9, 0, discoveredCounter),
    publishedNoteId: null,
    skipReason: null,
    ...overrides,
  }
}

function controllerWith(opts: {
  store?: FakeReviewStore
  client?: FakeClient
  worker?: FakeWorker
  gate?: ConcurrencyGate
  pollIntervalMs?: number
  includeDrafts?: boolean
  perProjectMaxInFlight?: number
  laneMax?: number
  laneReserved?: number
  now?: () => Date
}) {
  const store = opts.store ?? new FakeReviewStore()
  const client = opts.client ?? new FakeClient(async () => [])
  const worker = opts.worker ?? new FakeWorker()
  const gate = opts.gate ?? new ConcurrencyGate(20)
  const controller = new ReviewController({
    store,
    client,
    worker,
    gate,
    pollIntervalMs: opts.pollIntervalMs,
    includeDrafts: opts.includeDrafts,
    perProjectMaxInFlight: opts.perProjectMaxInFlight,
    laneMax: opts.laneMax,
    laneReserved: opts.laneReserved,
    now: opts.now,
  })
  return { store, client, worker, gate, controller }
}

beforeEach(() => {
  discoveredCounter = 0
})

// ---------------------------------------------------------------------------
// Discovery: skip reasons
// ---------------------------------------------------------------------------

describe('classifySkipReason (pure)', () => {
  it('skips a draft unless include_drafts is set', () => {
    expect(classifySkipReason(summary({ draft: true }), false)).toBe('draft')
    expect(classifySkipReason(summary({ draft: true }), true)).toBeNull()
  })
  it('skips a fork', () => {
    expect(classifySkipReason(summary({ isFork: true }), false)).toBe('fork')
  })
  it('skips closed and merged', () => {
    expect(classifySkipReason(summary({ state: 'closed' }), false)).toBe('closed')
    expect(classifySkipReason(summary({ state: 'merged' }), false)).toBe('merged')
  })
  it('closed/merged takes priority over draft/fork', () => {
    expect(classifySkipReason(summary({ state: 'closed', draft: true, isFork: true }), false)).toBe('closed')
  })
  it('an open, non-draft, non-fork MR is not skipped', () => {
    expect(classifySkipReason(summary(), false)).toBeNull()
  })
})

describe('ReviewController discovery — skip reasons are recorded on the job', () => {
  it('draft MRs are skipped with reason "draft" and never marked claimable', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 1, headSha: 'sha1', draft: true })]),
    })
    await controller.poll()
    const found = await store.get({ projectId: 'my-org/service-a', mrIid: 1, headSha: 'sha1' })
    expect(found?.state).toBe('skipped')
    expect(found?.skipReason).toBe('draft')
  })

  it('include_drafts:true lets a draft through to discovered', async () => {
    const { store, controller } = controllerWith({
      includeDrafts: true,
      // Blocks dispatch (0 >= perProjectMaxInFlight is always true) so this
      // test can inspect the record discovery leaves behind, before
      // dispatch() would claim it in the same poll() tick.
      perProjectMaxInFlight: 0,
      client: new FakeClient(async () => [summary({ mrIid: 1, headSha: 'sha1', draft: true })]),
    })
    await controller.poll()
    const found = await store.get({ projectId: 'my-org/service-a', mrIid: 1, headSha: 'sha1' })
    expect(found?.state).toBe('discovered')
    expect(found?.skipReason).toBeNull()
  })

  it('fork MRs are skipped with reason "fork"', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 2, headSha: 'sha2', isFork: true })]),
    })
    await controller.poll()
    const found = await store.get({ projectId: 'my-org/service-a', mrIid: 2, headSha: 'sha2' })
    expect(found?.state).toBe('skipped')
    expect(found?.skipReason).toBe('fork')
  })

  it('closed MRs are skipped with reason "closed"', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 3, headSha: 'sha3', state: 'closed' })]),
    })
    await controller.poll()
    const found = await store.get({ projectId: 'my-org/service-a', mrIid: 3, headSha: 'sha3' })
    expect(found?.state).toBe('skipped')
    expect(found?.skipReason).toBe('closed')
  })

  it('merged MRs are skipped with reason "merged"', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 4, headSha: 'sha4', state: 'merged' })]),
    })
    await controller.poll()
    const found = await store.get({ projectId: 'my-org/service-a', mrIid: 4, headSha: 'sha4' })
    expect(found?.state).toBe('skipped')
    expect(found?.skipReason).toBe('merged')
  })

  it('headSha === "" requeues (no record persisted, not marked skipped) rather than being skipped', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 5, headSha: '' })]),
    })
    await controller.poll()
    // No key can even be formed with an empty headSha in any meaningful way;
    // assert the store never received a put() for this MR by checking there
    // is no record anywhere for mrIid 5 under any headSha, including "".
    const all = Array.from(store.records.values())
    expect(all.find((j) => j.key.mrIid === 5)).toBeUndefined()
    expect(all.some((j) => j.skipReason !== null)).toBe(false)
  })

  it('a duplicate candidate (same job key already on record) is not re-processed', async () => {
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 6, headSha: 'sha6' })]),
    })
    // First poll: discover() creates the record, dispatch() claims it in the same tick.
    await controller.poll()
    const afterFirst = await store.get({ projectId: 'my-org/service-a', mrIid: 6, headSha: 'sha6' })
    expect(afterFirst?.state).toBe('claimed')

    // Second poll with the client returning the very same candidate again
    // (simulating the deliberate overlap window re-fetching it). Dedup by
    // job key must mean discover() does nothing — the record must not be
    // reset back to 'discovered'.
    await controller.poll()
    const afterSecond = await store.get({ projectId: 'my-org/service-a', mrIid: 6, headSha: 'sha6' })
    expect(afterSecond?.state).toBe('claimed')
  })
})

// ---------------------------------------------------------------------------
// Cursor / overlap window
// ---------------------------------------------------------------------------

describe('ReviewController discovery — cursor overlap window', () => {
  it('queries with updatedAfter = null on the very first poll', async () => {
    const { client, controller } = controllerWith({ client: new FakeClient(async () => []) })
    await controller.poll()
    expect(client.calls[0].updatedAfter).toBeNull()
  })

  it('persists the true high-water mark, then queries with a window subtracting ~2 poll intervals', async () => {
    const pollIntervalMs = 60000
    const firstBatchUpdatedAt = new Date('2026-08-10T10:00:00.000Z')
    let call = 0
    const client = new FakeClient(async () => {
      call++
      if (call === 1) return [summary({ mrIid: 1, headSha: 'sha1', updatedAt: firstBatchUpdatedAt })]
      return []
    })
    const { controller } = controllerWith({ client, pollIntervalMs })
    await controller.poll() // discovers mrIid 1, writes cursor = firstBatchUpdatedAt
    await controller.poll() // second poll should query with the overlap window

    const secondCallCursor = client.calls[1].updatedAfter
    expect(secondCallCursor).not.toBeNull()
    const expected = firstBatchUpdatedAt.getTime() - 2 * pollIntervalMs
    expect(secondCallCursor!.getTime()).toBe(expected)
  })

  it('the stored cursor itself is the true high-water mark, not the overlapped query bound', async () => {
    const updatedAt = new Date('2026-08-10T10:00:00.000Z')
    const { store, controller } = controllerWith({
      client: new FakeClient(async () => [summary({ mrIid: 1, headSha: 'sha1', updatedAt })]),
      pollIntervalMs: 60000,
    })
    await controller.poll()
    expect(store.cursor?.getTime()).toBe(updatedAt.getTime())
  })
})

// ---------------------------------------------------------------------------
// buildRoundRobinQueue (pure)
// ---------------------------------------------------------------------------

describe('buildRoundRobinQueue (pure)', () => {
  it('interleaves projects instead of preserving flat discovery/updated_at order', () => {
    const a = (n: number) =>
      job({ key: { projectId: 'org/a', mrIid: n, headSha: `a${n}` }, discoveredAt: new Date(2026, 0, 1, 0, n) })
    const b = job({ key: { projectId: 'org/b', mrIid: 1, headSha: 'b1' }, discoveredAt: new Date(2026, 0, 1, 0, 0) })

    const input = [a(1), a(2), a(3), b]
    const out = buildRoundRobinQueue(input)
    const projectSeq = out.map((j) => j.key.projectId)
    // org/a's second job must NOT immediately follow its first — org/b's job
    // must be interleaved between them.
    expect(projectSeq).toEqual(['org/a', 'org/b', 'org/a', 'org/a'])
  })

  it('within one project, oldest discoveredAt goes first', () => {
    const newer = job({ key: { projectId: 'org/a', mrIid: 2, headSha: 'a2' }, discoveredAt: new Date(2026, 0, 2) })
    const older = job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' }, discoveredAt: new Date(2026, 0, 1) })
    const out = buildRoundRobinQueue([newer, older])
    expect(out.map((j) => j.key.mrIid)).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// FAIRNESS TEST — dispatch order, not just set membership or counts
// ---------------------------------------------------------------------------

describe('ReviewController dispatch — FAIRNESS across projects', () => {
  it('project B (1 open MR) is dispatched before project A\'s second MR (10 open MRs), by ORDER not just membership', async () => {
    const store = new FakeReviewStore()
    // Project A: 10 discovered MRs. Project B: 1 discovered MR.
    for (let i = 1; i <= 10; i++) {
      store.seed(
        job({
          key: { projectId: 'org/project-a', mrIid: i, headSha: `a${i}` },
          discoveredAt: new Date(2026, 0, 1, 0, i),
        }),
      )
    }
    // B's MR is deliberately the CHRONOLOGICALLY LAST candidate of all
    // eleven (discovered after every one of A's ten). This is what makes the
    // test load-bearing: a naive "plain updated_at/discoveredAt order"
    // implementation would put B dead last (after all ten of A's), and only
    // a genuine round-robin-by-project dispatch puts it early despite that.
    // If B happened to be the chronologically *earliest* candidate instead,
    // a plain-order sabotage would accidentally dispatch it first too, and
    // this test would not catch the regression.
    store.seed(
      job({
        key: { projectId: 'org/project-b', mrIid: 1, headSha: 'b1' },
        discoveredAt: new Date(2026, 0, 1, 0, 11),
      }),
    )

    const worker = new FakeWorker() // resolves immediately, so per-project cap does not block subsequent rounds
    const { controller } = controllerWith({
      store,
      worker,
      // Deliberately generous so per_project_max_in_flight does not interfere
      // with this specific assertion — this test isolates ORDER, a separate
      // test below isolates the per-project cap.
      perProjectMaxInFlight: 5,
      laneMax: 20,
      gate: new ConcurrencyGate(20),
    })

    await controller.poll()

    const order = worker.dispatchOrder
    const bIndex = order.indexOf('org/project-b#1')
    const aSecondIndex = order.indexOf('org/project-a#2')

    expect(bIndex).toBeGreaterThanOrEqual(0)
    expect(aSecondIndex).toBeGreaterThanOrEqual(0)
    // The load-bearing assertion: B's only MR — despite being the newest
    // candidate of all eleven — must still be dispatched strictly before
    // A's SECOND MR. A plain-chronological-order implementation would
    // dispatch all ten of A's MRs (each older than B's) before ever reaching
    // B's, landing B at index 10 — this assertion fails against that
    // ordering and only passes against true round-robin-by-project.
    expect(bIndex).toBeLessThan(aSecondIndex)

    // Round-robin by project also means B is dispatched no later than
    // second overall (first round: A1, B1, in alphabetical project order).
    expect(bIndex).toBeLessThanOrEqual(1)
  })

  it('per_project_max_in_flight (default 1) is honoured: project A never holds two slots concurrently', async () => {
    const store = new FakeReviewStore()
    for (let i = 1; i <= 10; i++) {
      store.seed(
        job({
          key: { projectId: 'org/project-a', mrIid: i, headSha: `a${i}` },
          discoveredAt: new Date(2026, 0, 1, 0, i),
        }),
      )
    }
    store.seed(
      job({ key: { projectId: 'org/project-b', mrIid: 1, headSha: 'b1' }, discoveredAt: new Date(2026, 0, 1, 0, 0) }),
    )

    const worker = new FakeWorker()
    worker.pending = true // hold every dispatched job open, so we can inspect in-flight state
    const { controller } = controllerWith({
      store,
      worker,
      perProjectMaxInFlight: 1, // the default — spelled out explicitly here
      laneMax: 20,
      gate: new ConcurrencyGate(20),
    })

    await controller.poll()

    const aDispatches = worker.dispatchOrder.filter((d) => d.startsWith('org/project-a#'))
    // Only ONE of project A's ten candidates may be in flight at once, even
    // though the gate has ample global and lane capacity for all of them.
    expect(aDispatches.length).toBe(1)
    const bDispatches = worker.dispatchOrder.filter((d) => d.startsWith('org/project-b#'))
    expect(bDispatches.length).toBe(1)
  })

  it('once the in-flight job for a project completes, the next candidate for that project becomes dispatchable', async () => {
    const store = new FakeReviewStore()
    store.seed(job({ key: { projectId: 'org/project-a', mrIid: 1, headSha: 'a1' } }))
    store.seed(job({ key: { projectId: 'org/project-a', mrIid: 2, headSha: 'a2' } }))

    const worker = new FakeWorker()
    worker.pending = true
    const { controller } = controllerWith({ store, worker, perProjectMaxInFlight: 1 })

    await controller.poll()
    expect(worker.dispatchOrder.filter((d) => d.startsWith('org/project-a#')).length).toBe(1)

    worker.resolveOne({ projectId: 'org/project-a', mrIid: 1, headSha: 'a1' })
    await Promise.resolve() // let the finally block in beginWork run
    await Promise.resolve()

    await controller.poll()
    expect(worker.dispatchOrder.filter((d) => d.startsWith('org/project-a#')).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Claim races
// ---------------------------------------------------------------------------

describe('ReviewController dispatch — losing a claim race', () => {
  it('is silent (not an error) and does not fail the tick; other jobs still dispatch', async () => {
    const store = new FakeReviewStore()
    const loserKey: ReviewJobKey = { projectId: 'org/a', mrIid: 1, headSha: 'a1' }
    const winnerKey: ReviewJobKey = { projectId: 'org/a', mrIid: 2, headSha: 'a2' }
    store.seed(job({ key: loserKey, discoveredAt: new Date(2026, 0, 1, 0, 1) }))
    store.seed(job({ key: winnerKey, discoveredAt: new Date(2026, 0, 1, 0, 2) }))
    store.claimFailKeys.add(keyString(loserKey))

    const worker = new FakeWorker()
    const { controller } = controllerWith({ store, worker, perProjectMaxInFlight: 5 })

    await expect(controller.poll()).resolves.toBeUndefined() // must not throw

    expect(worker.calls.find((c) => c.job.key.mrIid === 1)).toBeUndefined()
    expect(worker.calls.find((c) => c.job.key.mrIid === 2)).toBeDefined()
  })

  it('a claim() call that throws is also swallowed, and the tick continues', async () => {
    const store = new FakeReviewStore()
    const badKey: ReviewJobKey = { projectId: 'org/a', mrIid: 1, headSha: 'a1' }
    const goodKey: ReviewJobKey = { projectId: 'org/a', mrIid: 2, headSha: 'a2' }
    store.seed(job({ key: badKey, discoveredAt: new Date(2026, 0, 1, 0, 1) }))
    store.seed(job({ key: goodKey, discoveredAt: new Date(2026, 0, 1, 0, 2) }))
    const realClaim = store.claim.bind(store)
    store.claim = async (key: ReviewJobKey) => {
      if (key.mrIid === 1) throw new Error('disk exploded')
      return realClaim(key)
    }

    const worker = new FakeWorker()
    const { controller } = controllerWith({ store, worker, perProjectMaxInFlight: 5 })

    await expect(controller.poll()).resolves.toBeUndefined()
    expect(worker.calls.find((c) => c.job.key.mrIid === 2)).toBeDefined()
  })

  it('the gate lease is released when a claim is lost, so global capacity is not leaked', async () => {
    const store = new FakeReviewStore()
    const loserKey: ReviewJobKey = { projectId: 'org/a', mrIid: 1, headSha: 'a1' }
    const winnerKey: ReviewJobKey = { projectId: 'org/a', mrIid: 2, headSha: 'a2' }
    store.seed(job({ key: loserKey, discoveredAt: new Date(2026, 0, 1, 0, 1) }))
    store.seed(job({ key: winnerKey, discoveredAt: new Date(2026, 0, 1, 0, 2) }))
    store.claimFailKeys.add(keyString(loserKey))

    const worker = new FakeWorker()
    worker.pending = true
    const gate = new ConcurrencyGate(1) // only one global slot: proves the lost claim's lease came back
    const { controller } = controllerWith({ store, worker, gate, perProjectMaxInFlight: 5, laneMax: 5 })

    await controller.poll()
    // The winner got the single global slot even though the loser was tried first.
    expect(worker.calls.length).toBe(1)
    expect(worker.calls[0].job.key.mrIid).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

describe('ReviewController — recoverAndRedispatch', () => {
  it('re-dispatches every claimed/running record from recoverInFlight without calling store.claim() again', async () => {
    const store = new FakeReviewStore()
    store.recoverJobs = [
      job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' }, state: 'claimed' }),
      job({ key: { projectId: 'org/a', mrIid: 2, headSha: 'a2' }, state: 'running' }),
    ]
    const worker = new FakeWorker()
    const { controller } = controllerWith({ store, worker })

    await controller.recoverAndRedispatch()

    expect(worker.calls.length).toBe(2)
    expect(store.claimCalls.length).toBe(0)
  })

  it('recovered jobs still go through the gate — a restart cannot exceed the ceiling', async () => {
    const store = new FakeReviewStore()
    store.recoverJobs = [
      job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' } }),
      job({ key: { projectId: 'org/a', mrIid: 2, headSha: 'a2' } }),
    ]
    const worker = new FakeWorker()
    worker.pending = true
    const gate = new ConcurrencyGate(1)
    const { controller } = controllerWith({ store, worker, gate, laneMax: 1 })

    await controller.recoverAndRedispatch()
    expect(worker.calls.length).toBe(1) // only one global slot available
  })
})

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('ReviewController — stop()', () => {
  it('aborts every live worker invocation through its AbortController', async () => {
    const store = new FakeReviewStore()
    store.seed(job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' } }))
    const worker = new FakeWorker()
    worker.pending = true
    const { controller } = controllerWith({ store, worker })

    await controller.poll()
    expect(worker.calls[0].signal.aborted).toBe(false)
    controller.stop()
    expect(worker.calls[0].signal.aborted).toBe(true)
  })

  it('does not touch the store — the claimed record is left claimed for the next start', async () => {
    const store = new FakeReviewStore()
    store.seed(job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' } }))
    const worker = new FakeWorker()
    worker.pending = true
    const { controller } = controllerWith({ store, worker })

    await controller.poll()
    const beforeStop = await store.get({ projectId: 'org/a', mrIid: 1, headSha: 'a1' })
    expect(beforeStop?.state).toBe('claimed')

    controller.stop()

    const afterStop = await store.get({ projectId: 'org/a', mrIid: 1, headSha: 'a1' })
    expect(afterStop?.state).toBe('claimed')
  })
})

// ---------------------------------------------------------------------------
// A poll that throws does not kill the loop
// ---------------------------------------------------------------------------

describe('ReviewController — run() survives a throwing poll', () => {
  it('keeps polling after discover() throws, and stop() ends the loop cleanly', async () => {
    vi.useFakeTimers()
    try {
      let callCount = 0
      const client = new FakeClient(async () => {
        callCount++
        if (callCount === 1) throw new Error('gitlab is down')
        return []
      })
      const { controller } = controllerWith({ client, pollIntervalMs: 1000 })

      const runPromise = controller.run()

      // First tick happens synchronously-ish inside run(); let microtasks flush.
      await vi.advanceTimersByTimeAsync(0)
      expect(callCount).toBe(1) // the throwing call happened

      // Advance past the poll interval — the loop must still be alive.
      await vi.advanceTimersByTimeAsync(1000)
      expect(callCount).toBe(2) // a second poll happened: the first throw did not kill run()

      controller.stop()
      await vi.advanceTimersByTimeAsync(1000)
      await runPromise

      expect(callCount).toBe(2) // no further polls after stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Gate integration: laneMax / global capacity actually bound dispatch
// ---------------------------------------------------------------------------

describe('ReviewController dispatch — respects the concurrency gate', () => {
  it('stops dispatching once the gate denies further leases, even with more claimable jobs waiting', async () => {
    const store = new FakeReviewStore()
    for (let i = 1; i <= 5; i++) {
      store.seed(job({ key: { projectId: `org/p${i}`, mrIid: 1, headSha: `s${i}` } }))
    }
    const worker = new FakeWorker()
    worker.pending = true
    const gate = new ConcurrencyGate(2) // hard ceiling well below the 5 candidates
    const { controller } = controllerWith({ store, worker, gate, laneMax: 10, perProjectMaxInFlight: 10 })

    await controller.poll()
    expect(worker.calls.length).toBe(2)
  })

  it('the reserved floor is passed through: implementation-style saturation of the gate still lets review dispatch its reserved slot', async () => {
    const globalMax = 2
    const gate = new ConcurrencyGate(globalMax)
    const store = new FakeReviewStore()
    store.seed(job({ key: { projectId: 'org/a', mrIid: 1, headSha: 'a1' } }))

    // Simulate an implementation lane taking every slot except review's reserved one.
    const other = gate.tryAcquire('implementation', globalMax, 0)
    expect(other).not.toBeNull() // takes 1 of 2 global slots; review's reserved=1 still protects the 2nd

    const worker = new FakeWorker()
    const { controller } = controllerWith({ store, worker, gate, laneMax: 2, laneReserved: 1 })

    await controller.poll()
    expect(worker.calls.length).toBe(1) // review still got its reserved slot
  })
})
