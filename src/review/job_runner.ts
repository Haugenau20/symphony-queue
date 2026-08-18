/**
 * The seam between the review controller and the two halves of the work.
 *
 * The controller (review/controller.ts) owns scheduling: polling, claiming,
 * fairness, the concurrency gate. It hands a claimed job to a `ReviewWorker`
 * and expects that to be the end of it — the controller deliberately never
 * inspects or sets job state past the claim.
 *
 * The work itself is split in two, and the split is a security boundary rather
 * than a decomposition preference: `ReviewWorker` (review/worker.ts) builds a
 * disposable sandbox and runs an agent that holds no credential and has no
 * egress, and `ReviewPublisher` (review/publisher.ts) is the only component in
 * the process that writes to GitLab. Neither can do the other's job — their
 * client types are disjoint `Pick`s of `MergeRequestClient`, so a worker that
 * tried to post a note would not compile.
 *
 * This module composes the two and translates their outcomes into the store's
 * job states. It exists so that neither half has to know about scheduling and
 * the scheduler does not have to know about publishing.
 *
 * Where the states come from:
 *
 *   worker 'reviewed'   -> publisher decides: published / already_published
 *                          (both terminal 'published'), superseded, or a
 *                          rejected document (a failed run, retried)
 *   worker 'too_large'  -> 'skipped', with the reason recorded. Not a failure:
 *                          retrying an unchanged too-large diff cannot succeed.
 *   worker 'stale'      -> 'superseded'. The head moved; a new job key already
 *                          exists (or will, on the next poll) for the new head.
 *   worker 'failed'     -> 'failed' with attempts incremented and a retry
 *                          deadline, so listClaimable picks it up again until
 *                          maxAttempts.
 *   thrown error        -> same as 'failed'. A crash mid-review must not leave
 *                          a record stuck in 'claimed' forever.
 *
 * Nothing here publishes on its own, and nothing here can reach GitLab except
 * through the publisher it is given.
 */

import type { MergeRequestDiffFile, ReviewJob, ReviewProvenance, ReviewStore } from './types.js'
import type { ReviewWorkOutcome } from './worker.js'
import type { PublishResult } from './publisher.js'
import { backoffDelay } from '../orchestrator.js'
import { getLogger } from '../log.js'

/** The half that produces findings. Structural, so tests need no OpenCode client. */
export interface FindingsProducer {
  run(job: ReviewJob, signal?: AbortSignal): Promise<ReviewWorkOutcome>
}

/** The half that writes to GitLab. Structural, so tests need no network. */
export interface FindingsPublisher {
  publish(request: {
    job: ReviewJob
    findings: unknown
    diffFiles: MergeRequestDiffFile[]
    /**
     * The same files, handed to the publisher as placement material. Passed
     * from the SAME value as diffFiles so the two cannot drift: a publisher
     * that positions findings against a different file set than it validates
     * them against is a wrong-line comment waiting to happen.
     */
    placementFiles?: MergeRequestDiffFile[]
    /**
     * How the findings were produced — chunk count, failed chunks, whether the
     * self-critique ran, what was excluded. The publisher renders it as the
     * note's provenance footer. Optional so a publisher that does not care
     * still satisfies this type, but the runner ALWAYS passes it: design §12
     * requires a chunked review to say so in the note rather than present a
     * batched reading as a whole one, and this is the only path by which that
     * reaches GitLab in the real pipeline.
     */
    provenance?: ReviewProvenance
  }): Promise<PublishResult>
}

export interface ReviewJobRunnerConfig {
  worker: FindingsProducer
  publisher: FindingsPublisher
  store: ReviewStore
  /** Ceiling on retries, matched to the store's own so a job cannot be retried past what listClaimable will return. */
  maxAttempts?: number
  maxRetryBackoffMs?: number
  now?: () => Date
}

export class ReviewJobRunner {
  private readonly worker: FindingsProducer
  private readonly publisher: FindingsPublisher
  private readonly store: ReviewStore
  private readonly maxAttempts: number
  private readonly maxRetryBackoffMs: number
  private readonly now: () => Date

  constructor(config: ReviewJobRunnerConfig) {
    this.worker = config.worker
    this.publisher = config.publisher
    this.store = config.store
    this.maxAttempts = config.maxAttempts ?? 3
    this.maxRetryBackoffMs = config.maxRetryBackoffMs ?? 300000
    this.now = config.now ?? (() => new Date())
  }

  /**
   * The controller's `ReviewWorker` shape. Resolves when the job has reached a
   * recorded state — it never rejects, because the controller treats a throw as
   * an unhandled dispatch error and the record would be left mid-flight.
   */
  async runJob(job: ReviewJob, signal: AbortSignal): Promise<void> {
    const log = getLogger()
    const { projectId, mrIid, headSha } = job.key

    try {
      await this.store.update({ ...job, state: 'running' })

      const outcome = await this.worker.run(job, signal)

      switch (outcome.kind) {
        case 'too_large':
          log.info(
            { project: projectId, mrIid, reason: outcome.reason, totalBytes: outcome.totalBytes },
            'review_skipped_too_large',
          )
          await this.store.update({
            ...job,
            state: 'skipped',
            skipReason: `diff too large to review automatically (${outcome.reason})`,
          })
          return

        case 'stale':
          log.info({ project: projectId, mrIid, headSha }, 'review_superseded_before_publish')
          await this.store.update({ ...job, state: 'superseded', skipReason: outcome.reason })
          return

        case 'failed':
          await this.recordFailure(job, outcome.reason)
          return

        case 'reviewed':
          await this.publish(job, outcome)
          return
      }
    } catch (err) {
      // Includes an aborted run: both stop() and supersession abort live
      // work through the same AbortController, and there is no reliable way
      // to tell them apart from the thrown error alone (an AbortError looks
      // the same either way). The two cases need opposite handling —
      // stop()'s abort must still land as a retryable failure (design §12:
      // "leave records claimed for the next start"), while a supersession
      // abort must NOT consume a retry attempt on a revision that is already
      // pointless — so the record itself, not the abort reason, is the
      // source of truth: re-read it, and if the controller has already
      // marked it 'superseded' (which only supersession ever does), there is
      // nothing left for this run to record.
      const current = await this.store.get(job.key).catch(() => null)
      if (current?.state === 'superseded') {
        log.info(
          { project: projectId, mrIid, headSha },
          'review_run_aborted_by_supersession',
        )
        return
      }
      await this.recordFailure(job, describe(err))
    }
  }

  private async publish(job: ReviewJob, outcome: Extract<ReviewWorkOutcome, { kind: 'reviewed' }>): Promise<void> {
    const log = getLogger()
    const { projectId, mrIid } = job.key

    await this.store.update({ ...job, state: 'publishing' })

    const result = await this.publisher.publish({
      job,
      findings: outcome.findings,
      diffFiles: outcome.diffFiles,
      placementFiles: outcome.diffFiles,
      provenance: outcome.provenance,
    })

    switch (result.status) {
      case 'published':
        log.info({ project: projectId, mrIid, noteId: result.noteId }, 'review_published')
        await this.store.update({ ...job, state: 'published', publishedNoteId: result.noteId })
        return

      case 'already_published':
        // A previous attempt got as far as posting. Idempotent by design: the
        // marker note is the record, so this is a success, not a duplicate.
        log.info({ project: projectId, mrIid, noteId: result.noteId }, 'review_already_published')
        await this.store.update({ ...job, state: 'published', publishedNoteId: result.noteId })
        return

      case 'superseded':
        log.info({ project: projectId, mrIid }, 'review_superseded_at_publish')
        await this.store.update({ ...job, state: 'superseded' })
        return

      case 'rejected':
        // The agent's findings document failed validation. That is a failed
        // run, never a partial publish — nothing reached GitLab.
        await this.recordFailure(job, `findings rejected: ${result.reason}`)
        return
    }
  }

  /**
   * One failure path for every kind of failure, so a crash and a rejected
   * document age out of the retry budget identically. `backoffDelay` is
   * imported rather than reimplemented: one backoff formula in this codebase
   * stays one formula.
   */
  private async recordFailure(job: ReviewJob, reason: string): Promise<void> {
    const attempts = job.attempts + 1
    const exhausted = attempts >= this.maxAttempts
    const nextRetryAt = exhausted
      ? null
      : new Date(this.now().getTime() + backoffDelay(attempts, this.maxRetryBackoffMs))

    getLogger().warn(
      {
        project: job.key.projectId,
        mrIid: job.key.mrIid,
        attempts,
        exhausted,
        reason,
      },
      'review_job_failed',
    )

    await this.store.update({ ...job, state: 'failed', attempts, nextRetryAt, skipReason: reason })
  }
}

/** Error text only — never a response body, and never a token. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
