/**
 * The review controller: polls GitLab for merge requests, turns candidates
 * into `ReviewJob` records, and dispatches claimed jobs to a worker under the
 * shared `ConcurrencyGate` (design §6, §7, §12).
 *
 * Deliberately mirrors the *shape* of `orchestrator.ts`'s poll loop — a tick
 * that never lets a single failure kill the loop, cancellation wired through
 * a real `AbortController` rather than one nothing listens to, records left
 * claimed on stop so the next start recovers them — without reusing any of
 * its issue-shaped code. Review jobs are not issues; forcing them through
 * `TrackerAdapter`'s state machine is exactly what this feature avoids.
 *
 * `worker.ts` and `publisher.ts` (wave 3b) are not imported here. This module
 * depends only on the narrow `ReviewWorker` interface declared below, injected
 * by whoever wires the process together. The worker owns everything from
 * `claimed` onward — fetching material, running the agent, validating and
 * publishing findings, and recording the terminal state. The controller's
 * job ends at a successful `store.claim()`.
 */

import { getLogger } from '../log.js'
import type { ConcurrencyGate, Lease } from '../concurrency.js'
import type {
  MergeRequestClient,
  MergeRequestSummary,
  ReviewJob,
  ReviewJobKey,
  ReviewJobState,
  ReviewStore,
} from './types.js'

/**
 * What the controller needs from the rest of the review pipeline (worker.ts,
 * wave 3b). One entry point: run one job to completion, honouring the
 * abort signal. The worker is responsible for every state transition from
 * `claimed` onward (`running` -> `publishing` -> a terminal state), including
 * writing those transitions back through the store — the controller never
 * inspects or sets job state itself past the claim.
 */
export interface ReviewWorker {
  runJob(job: ReviewJob, signal: AbortSignal): Promise<void>
}

export interface ReviewControllerConfig {
  store: ReviewStore
  client: MergeRequestClient
  worker: ReviewWorker
  gate: ConcurrencyGate

  /** `review.poll_interval_ms` (design §13). Default 60000. */
  pollIntervalMs?: number
  /** `review.include_drafts` (design §13). Default false — drafts are skipped. */
  includeDrafts?: boolean
  /** `concurrency.per_project_max_in_flight` (design §7, §13). Default 1. */
  perProjectMaxInFlight?: number
  /** `concurrency.review_max` (design §6). Default 2. */
  laneMax?: number
  /** `concurrency.review_reserved` (design §6). Default 1. */
  laneReserved?: number
  /**
   * `review.rereview_on_new_head` (design §12). Default true: when a new head
   * SHA is discovered for a merge request that already has a record at a
   * different head, the new revision is reviewed and every prior non-terminal
   * revision is superseded immediately — rather than left to run to
   * completion and be refused at publish time. false disables this: the
   * first review stands and a new head is never even discovered.
   */
  rereviewOnNewHead?: boolean
  /** Injectable clock, for deterministic tests. */
  now?: () => Date
}

/** Every terminal-on-discovery reason this controller can assign, distinct from a worker-assigned skip. */
export type DiscoverySkipReason = 'draft' | 'fork' | 'closed' | 'merged'

/**
 * Discovery-time skip classification (design §1, §7). Order matters: a
 * closed or merged MR is skipped for that reason regardless of whether it
 * also happens to be a draft or a fork — those only matter for MRs still
 * open. Returns null when the candidate should proceed to `discovered`.
 */
export function classifySkipReason(summary: MergeRequestSummary, includeDrafts: boolean): DiscoverySkipReason | null {
  if (summary.state === 'closed') return 'closed'
  if (summary.state === 'merged') return 'merged'
  if (summary.isFork) return 'fork'
  if (summary.draft && !includeDrafts) return 'draft'
  return null
}

/**
 * Orders claimable jobs round-robin by project rather than in `updated_at` (or
 * discovery) order, so that one repository with many open MRs cannot crowd
 * out every other repository (design §7, "Fairness across projects"). Project
 * order is alphabetical for determinism; within a project, oldest-discovered
 * first. Exported as a pure function so fairness can be asserted directly,
 * independent of dispatch/concurrency plumbing.
 */
export function buildRoundRobinQueue(jobs: ReviewJob[]): ReviewJob[] {
  const byProject = new Map<string, ReviewJob[]>()
  for (const job of jobs) {
    const list = byProject.get(job.key.projectId)
    if (list) list.push(job)
    else byProject.set(job.key.projectId, [job])
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => a.discoveredAt.getTime() - b.discoveredAt.getTime())
  }

  const projectIds = Array.from(byProject.keys()).sort((a, b) => a.localeCompare(b))
  const queues = projectIds.map((id) => byProject.get(id)!)

  const out: ReviewJob[] = []
  while (queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift()
      if (next) out.push(next)
    }
  }
  return out
}

function jobWorkKey(key: ReviewJobKey): string {
  return `${key.projectId}::${key.mrIid}::${key.headSha}`
}

/**
 * States a discovered-but-not-yet-terminal record can be superseded out of
 * (design §12). Deliberately excludes published/skipped/failed/superseded —
 * a published review of an older revision is a true historical record, not
 * something to rewrite, and a failed record is superseded by simply never
 * being retried once its replacement is discovered rather than by mutation.
 */
const SUPERSEDABLE_STATES: ReadonlySet<ReviewJobState> = new Set(['discovered', 'claimed', 'running', 'publishing'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ReviewController {
  private readonly store: ReviewStore
  private readonly client: MergeRequestClient
  private readonly worker: ReviewWorker
  private readonly gate: ConcurrencyGate

  private readonly pollIntervalMs: number
  private readonly includeDrafts: boolean
  private readonly perProjectMaxInFlight: number
  private readonly laneMax: number
  private readonly laneReserved: number
  private readonly rereviewOnNewHead: boolean
  private readonly now: () => Date

  private running = false
  private readonly perProjectInFlight = new Map<string, number>()
  private readonly liveWork = new Map<string, AbortController>()

  constructor(config: ReviewControllerConfig) {
    this.store = config.store
    this.client = config.client
    this.worker = config.worker
    this.gate = config.gate

    this.pollIntervalMs = config.pollIntervalMs ?? 60000
    this.includeDrafts = config.includeDrafts ?? false
    this.perProjectMaxInFlight = config.perProjectMaxInFlight ?? 1
    this.laneMax = config.laneMax ?? 2
    this.laneReserved = config.laneReserved ?? 1
    this.rereviewOnNewHead = config.rereviewOnNewHead ?? true
    this.now = config.now ?? (() => new Date())
  }

  isRunning(): boolean {
    return this.running
  }

  /** Number of jobs currently dispatched to the worker, for a given project (test/observability hook). */
  inFlightForProject(projectId: string): number {
    return this.perProjectInFlight.get(projectId) ?? 0
  }

  async run(): Promise<void> {
    this.running = true
    getLogger().info('review_controller_started')
    await this.recoverAndRedispatch()
    while (this.running) {
      await this.safePoll()
      if (!this.running) break
      await sleep(this.pollIntervalMs)
    }
    getLogger().info('review_controller_stopped')
  }

  /**
   * Stops accepting new jobs and aborts every live worker invocation through
   * its `AbortController`. Deliberately does not touch the store: claimed
   * records stay claimed on disk, exactly as design §12 requires ("leave
   * records claimed for the next start"), and `recoverAndRedispatch` picks
   * them back up next time `run()` starts.
   */
  stop(): void {
    this.running = false
    for (const controller of this.liveWork.values()) controller.abort()
  }

  /** One discovery+dispatch cycle. Public so tests can drive a single tick without the real poll timer. */
  async poll(): Promise<void> {
    await this.discover()
    await this.dispatch()
  }

  private async safePoll(): Promise<void> {
    try {
      await this.poll()
    } catch (err) {
      // A poll that throws must not kill the loop: log and let the next tick
      // retry, mirroring orchestrator.ts's handling of a failed
      // fetchCandidateIssues rather than letting the exception unwind run().
      getLogger().error({ error: describeError(err) }, 'review_poll_failed')
    }
  }

  /**
   * Startup recovery (design §12: "Claimed and running records are
   * re-dispatched. Safe because nothing was published"). Every record
   * `recoverInFlight()` returns was already claimed by *some* process before
   * it went away, so these skip `store.claim()` entirely and go straight to
   * the worker — re-running costs a little wall-clock time and nothing else.
   */
  async recoverAndRedispatch(): Promise<void> {
    let jobs: ReviewJob[]
    try {
      jobs = await this.store.recoverInFlight()
    } catch (err) {
      getLogger().error({ error: describeError(err) }, 'review_recover_in_flight_failed')
      return
    }
    for (const job of jobs) {
      getLogger().info(
        { project: job.key.projectId, mrIid: job.key.mrIid, headSha: job.key.headSha },
        'review_recovering_in_flight',
      )
      this.beginWork(job, { recovered: true })
    }
  }

  // --- discovery ---------------------------------------------------------------

  private async discover(): Promise<void> {
    const storedCursor = await this.store.readCursor()
    // Deliberate overlap window (design §7): the query looks back further
    // than the stored high-water mark, because `updated_at` ordering under
    // concurrent updates is not a reliable cursor on its own. Dedup by job
    // key (in processSummary) makes the re-scan free.
    const overlapMs = this.pollIntervalMs * 2
    const queryCursor = storedCursor ? new Date(storedCursor.getTime() - overlapMs) : null

    const summaries = await this.client.listOpenMergeRequests({ updatedAfter: queryCursor })

    let maxUpdatedAt = storedCursor
    // The earliest updated_at among candidates this poll deliberately did
    // NOT record (headSha === '', diff not ready — see processSummary). The
    // persisted cursor must never advance to or past this, or the requeue
    // promise breaks: a later poll's overlap window is finite, and GitLab is
    // not guaranteed to bump updated_at when async diff preparation finishes
    // (prepared_at is tracked separately precisely because it is a distinct
    // step). Without this clamp the MR could silently never be reviewed —
    // worse than a noisy skip, because nothing records that it happened.
    let earliestNotReady: Date | null = null
    for (const summary of summaries) {
      if (!maxUpdatedAt || summary.updatedAt.getTime() > maxUpdatedAt.getTime()) maxUpdatedAt = summary.updatedAt
      if (summary.headSha === '' && (!earliestNotReady || summary.updatedAt.getTime() < earliestNotReady.getTime())) {
        earliestNotReady = summary.updatedAt
      }
      await this.processSummary(summary)
    }

    // The cursor we persist is the true high-water mark, not the overlapped
    // query bound — the overlap is applied only when reading it back. But it
    // is clamped to strictly before any not-ready candidate in this batch,
    // so that candidate remains within a future query's window regardless of
    // how the cursor advances afterward.
    let cursorToWrite = maxUpdatedAt
    if (earliestNotReady) {
      const clamp = new Date(earliestNotReady.getTime() - 1)
      if (!cursorToWrite || clamp.getTime() < cursorToWrite.getTime()) cursorToWrite = clamp
    }

    if (cursorToWrite && (!storedCursor || cursorToWrite.getTime() > storedCursor.getTime())) {
      await this.store.writeCursor(cursorToWrite)
    }
  }

  private async processSummary(summary: MergeRequestSummary): Promise<void> {
    if (summary.headSha === '') {
      // Diff not ready yet (design §12). headSha is part of the job key, so
      // there is no key to persist a record under. Do NOT mark this
      // skipped — leave it undiscovered and let a later poll's overlap
      // window pick it up once GitLab has prepared the diff and bumped
      // updated_at.
      getLogger().info(
        { project: summary.projectId, mrIid: summary.mrIid },
        'review_diff_not_ready_requeue',
      )
      return
    }

    const key: ReviewJobKey = { projectId: summary.projectId, mrIid: summary.mrIid, headSha: summary.headSha }

    // Dedup by job key (design §8): a record already exists for this exact
    // revision — discovered, claimed, terminal, whatever — so there is
    // nothing new to do. This is what makes the overlap window free.
    const existing = await this.store.get(key)
    if (existing) return

    // Phase 2 (design §12): find out whether this merge request already has
    // a record at some OTHER head SHA before writing the new one — the
    // rereviewOnNewHead:false branch below must not create a record at all,
    // so this has to be known first, not decided after the fact.
    let priorRecords: ReviewJob[] = []
    try {
      priorRecords = await this.store.listForMergeRequest(summary.projectId, summary.mrIid)
    } catch (err) {
      getLogger().error(
        { project: summary.projectId, mrIid: summary.mrIid, error: describeError(err) },
        'review_list_for_mr_failed',
      )
    }
    const hasOtherRevision = priorRecords.some((r) => r.key.headSha !== summary.headSha)

    if (hasOtherRevision && !this.rereviewOnNewHead) {
      // rereview_on_new_head is off: the first review of this merge request
      // stands. Do not create a record for the new head at all, and leave
      // every existing record exactly as it is.
      getLogger().info(
        { project: summary.projectId, mrIid: summary.mrIid, headSha: summary.headSha },
        'review_new_head_ignored',
      )
      return
    }

    const skipReason = classifySkipReason(summary, this.includeDrafts)

    const job: ReviewJob = {
      key,
      baseSha: summary.baseSha,
      startSha: summary.startSha,
      title: summary.title,
      webUrl: summary.webUrl,
      state: skipReason ? 'skipped' : 'discovered',
      attempts: 0,
      nextRetryAt: null,
      discoveredAt: this.now(),
      publishedNoteId: null,
      skipReason,
    }
    await this.store.put(job)

    if (skipReason) {
      getLogger().info(
        { project: summary.projectId, mrIid: summary.mrIid, headSha: summary.headSha, reason: skipReason },
        'review_mr_skipped',
      )
    }

    if (hasOtherRevision) {
      await this.supersedeOlderRevisions(summary)
    }
  }

  /**
   * Marks every prior, non-terminal record for this merge request — at any
   * head SHA other than the one just discovered — as 'superseded', and
   * aborts this process's live work for it if any is in flight (design §12:
   * a stale review is already worthless, so it should stop burning its
   * concurrency slot the moment a newer head is known, not run to completion
   * only to be refused at publish time).
   *
   * A public method, deliberately not inlined into processSummary, so
   * supersession itself is directly testable without driving discovery
   * end-to-end — the same reason {@link buildRoundRobinQueue} above is
   * exported as its own pure function.
   *
   * Terminal records (published/skipped/failed/superseded) are left exactly
   * as they are: a published review of an older revision is a true
   * historical record, not something to rewrite. A record claimed by a
   * process that has since died has no entry in this process's `liveWork`
   * map, so only its store state is updated — there is nothing to abort.
   */
  async supersedeOlderRevisions(summary: MergeRequestSummary): Promise<void> {
    let priorRecords: ReviewJob[]
    try {
      priorRecords = await this.store.listForMergeRequest(summary.projectId, summary.mrIid)
    } catch (err) {
      getLogger().error(
        { project: summary.projectId, mrIid: summary.mrIid, error: describeError(err) },
        'review_supersede_list_failed',
      )
      return
    }

    for (const record of priorRecords) {
      if (record.key.headSha === summary.headSha) continue
      if (!SUPERSEDABLE_STATES.has(record.state)) continue

      const workKey = jobWorkKey(record.key)

      // ORDER IS LOAD-BEARING: the store write happens BEFORE the abort.
      //
      // job_runner.ts cannot tell a supersession abort from a stop() abort by
      // the thrown error — both are an AbortError — so it re-reads the record
      // and treats 'superseded' as the signal. That only works if the record
      // already SAYS 'superseded' by the time the aborted run unwinds into its
      // catch block. Aborting first loses the race: abort() fires its
      // listeners synchronously, while a real store update is mkdir + write +
      // fsync + rename, several event loop turns later. The run would then
      // find its record still 'running', record a retryable failure, consume
      // an attempt on a revision that is already pointless, and race this
      // write to decide whether the record ends up 'superseded' or 'failed'.
      //
      // Written the other way round the race cannot happen at all: the record
      // is authoritative before anything can observe the cancellation.
      try {
        await this.store.update({
          ...record,
          state: 'superseded',
          skipReason: `superseded by new head ${summary.headSha}`,
        })
      } catch (err) {
        getLogger().error(
          {
            project: record.key.projectId,
            mrIid: record.key.mrIid,
            headSha: record.key.headSha,
            error: describeError(err),
          },
          'review_supersede_update_failed',
        )
        continue
      }

      // Only now, with the record authoritative on disk, cancel the live run.
      // A record claimed by a process that has since died has no entry here,
      // so the state update above is the whole of its supersession.
      const abortController = this.liveWork.get(workKey)
      if (abortController) abortController.abort()

      getLogger().info(
        {
          project: record.key.projectId,
          mrIid: record.key.mrIid,
          oldHeadSha: record.key.headSha,
          newHeadSha: summary.headSha,
          aborted: abortController !== undefined,
        },
        'review_revision_superseded',
      )
    }
  }

  // --- dispatch ------------------------------------------------------------------

  private async dispatch(): Promise<void> {
    let claimable: ReviewJob[]
    try {
      claimable = await this.store.listClaimable(this.now())
    } catch (err) {
      getLogger().error({ error: describeError(err) }, 'review_list_claimable_failed')
      return
    }

    const queue = buildRoundRobinQueue(claimable)

    for (const job of queue) {
      const projectId = job.key.projectId
      const inFlight = this.perProjectInFlight.get(projectId) ?? 0
      if (inFlight >= this.perProjectMaxInFlight) {
        // This project is at its floor for now. Not a reason to give up on
        // the rest of the queue — the next candidate is very likely a
        // different project (round-robin ordering), so try it.
        continue
      }

      const lease = this.gate.tryAcquire('review', this.laneMax, this.laneReserved)
      if (!lease) break // No global/lane capacity right now, and none will free up mid-tick.

      let claimed: boolean
      try {
        claimed = await this.store.claim(job.key)
      } catch (err) {
        lease.release()
        getLogger().error(
          { project: projectId, mrIid: job.key.mrIid, error: describeError(err) },
          'review_claim_errored',
        )
        continue
      }
      if (!claimed) {
        // Losing the claim race is normal (another process, or this
        // process's own prior recovery, already owns the record) — not an
        // error, and must not fail the tick.
        lease.release()
        continue
      }

      this.beginWork(job, { recovered: false, lease })
    }
  }

  // --- execution -------------------------------------------------------------------

  private beginWork(job: ReviewJob, opts: { recovered: boolean; lease?: Lease }): void {
    const projectId = job.key.projectId
    const lease = opts.lease ?? this.gate.tryAcquire('review', this.laneMax, this.laneReserved)
    if (!lease) {
      // Recovery also goes through the gate, so a restart can never exceed
      // its ceiling. If capacity is not available right now the record
      // simply stays claimed on disk; the next recoverAndRedispatch retries it.
      getLogger().warn(
        { project: projectId, mrIid: job.key.mrIid },
        'review_recovered_job_deferred_no_capacity',
      )
      return
    }

    this.perProjectInFlight.set(projectId, (this.perProjectInFlight.get(projectId) ?? 0) + 1)
    const abortController = new AbortController()
    const workKey = jobWorkKey(job.key)
    this.liveWork.set(workKey, abortController)

    getLogger().info(
      { project: projectId, mrIid: job.key.mrIid, headSha: job.key.headSha, recovered: opts.recovered },
      'review_dispatched',
    )

    void (async () => {
      try {
        await this.worker.runJob(job, abortController.signal)
      } catch (err) {
        getLogger().error(
          { project: projectId, mrIid: job.key.mrIid, error: describeError(err) },
          'review_worker_failed',
        )
      } finally {
        lease.release()
        this.liveWork.delete(workKey)
        const remaining = (this.perProjectInFlight.get(projectId) ?? 1) - 1
        if (remaining <= 0) this.perProjectInFlight.delete(projectId)
        else this.perProjectInFlight.set(projectId, remaining)
      }
    })()
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
