/**
 * The shared contract for the merge-request review pipeline.
 *
 * This file is written once, before the parallel slices start, and is FROZEN
 * for their duration. Several slices are implemented concurrently against
 * these signatures: gitlab_mr.ts, store.ts and findings.ts implement them,
 * controller.ts, worker.ts and publisher.ts consume them. A signature that
 * changes underneath a concurrent slice is the one failure that cannot be
 * caught by either slice's own tests.
 *
 * So: if a signature here is wrong, report it rather than editing it. Changing
 * it is the orchestrator's call, made once, for everyone.
 *
 * Nothing in here is a tracker. Review deliberately does not go through
 * TrackerAdapter (src/tracker/base.ts) — it is a different resource, with a
 * different credential, and forcing it through an issue-shaped interface is
 * what this design exists to avoid.
 */

export interface ReviewJobKey {
  projectId: string          // full path, e.g. "my-org/service-a"
  mrIid: number
  headSha: string
}

export type ReviewJobState =
  | 'discovered' | 'claimed' | 'running' | 'publishing'
  | 'published' | 'superseded' | 'skipped' | 'failed'

export interface ReviewJob {
  key: ReviewJobKey
  baseSha: string
  startSha: string
  title: string
  webUrl: string | null
  state: ReviewJobState
  attempts: number
  nextRetryAt: Date | null
  discoveredAt: Date
  publishedNoteId: string | null
  skipReason: string | null
}

export interface ReviewStore {
  get(key: ReviewJobKey): Promise<ReviewJob | null>
  put(job: ReviewJob): Promise<void>
  update(job: ReviewJob): Promise<void>
  /** rename(2)-based claim. Resolves false if another process won. */
  claim(key: ReviewJobKey): Promise<boolean>
  /** discovered, plus failed whose nextRetryAt is due. */
  listClaimable(now: Date): Promise<ReviewJob[]>
  /** claimed/running at startup — the set that was live when we died. */
  recoverInFlight(): Promise<ReviewJob[]>
  readCursor(): Promise<Date | null>
  writeCursor(at: Date): Promise<void>
  /**
   * Every record for one merge request, at ANY head SHA, in ANY state, newest
   * -discovered first.
   *
   * Phase 2 addition, for supersession. Every other lookup here is keyed by the
   * full {@link ReviewJobKey}, head SHA included — which is exactly the question
   * supersession cannot ask, because the whole point is to find the revisions a
   * newly discovered head displaces. Note that claimed/ and failed/ are keyed by
   * a hash of the full key, so those two cannot be found by deriving a path:
   * they have to be scanned and filtered.
   */
  listForMergeRequest(projectId: string, mrIid: number): Promise<ReviewJob[]>
}

export interface MergeRequestSummary {
  projectId: string
  mrIid: number
  headSha: string
  baseSha: string
  startSha: string
  title: string
  description: string | null
  draft: boolean
  isFork: boolean
  state: string
  webUrl: string | null
  updatedAt: Date
}

export interface MergeRequestDiffFile {
  oldPath: string
  newPath: string
  diff: string
  newFile: boolean
  renamedFile: boolean
  deletedFile: boolean
  generatedFile: boolean
  /** Empty diff body on a file GitLab reports as changed. */
  collapsed: boolean
}

export interface MergeRequestClient {
  listOpenMergeRequests(opts: { updatedAfter: Date | null }): Promise<MergeRequestSummary[]>
  getMergeRequest(projectId: string, mrIid: number): Promise<MergeRequestSummary | null>
  listDiffs(projectId: string, mrIid: number): Promise<MergeRequestDiffFile[]>
  getFileAtRef(projectId: string, path: string, ref: string): Promise<string | null>
  /**
   * `authorId` is what makes the publish marker trustworthy. Matching a marker
   * by substring alone means anyone who can comment on the merge request can
   * post `<!-- symphony-review:<sha> -->` themselves and silence the review for
   * that revision — the publisher would find it and record "already published".
   * Null when the instance did not report an author, which is treated as
   * "not ours".
   */
  listNotes(projectId: string, mrIid: number): Promise<Array<{ id: string; body: string; authorId: string | null }>>
  createNote(projectId: string, mrIid: number, body: string): Promise<string>
  /**
   * The user id this client's token authenticates as, for the check above.
   * Null when it cannot be determined — the publisher then falls back to
   * marker-only matching, because not double-posting matters more than not
   * being spoofable, and a review that refuses to publish is the worse failure.
   */
  getCurrentUserId(): Promise<string | null>
}

export interface Finding {
  severity: 'blocking' | 'concern' | 'nit'
  file: string
  line: number | null
  lineType: 'added' | 'removed' | 'context'
  title: string
  detail: string
  suggestion: string | null
}

export interface FindingsDocument {
  summary: string
  findings: Finding[]
}

// ===========================================================================
// PHASE 2
//
// Everything below is added for phase 2 and follows the same rule as
// everything above it: implemented and consumed by slices running in different
// waves, so it is FROZEN for their duration. A signature that is wrong is
// reported, not edited.
// ===========================================================================

// --- material planning -----------------------------------------------------

export type ExclusionReason =
  /** Matched a `review.exclude_paths` glob. */
  | 'exclude_path'
  /** GitLab's own `generated_file` flag — its answer, not our guess from a pattern. */
  | 'generated'
  /** GitLab returned an empty diff body for a file it reports as changed. */
  | 'collapsed'
  /** A binary diff marker: there is no text to review. */
  | 'binary'

export interface ExcludedFile {
  path: string
  reason: ExclusionReason
}

/** One agent-sized batch of review material. An unchunked review has exactly one. */
export interface ReviewChunk {
  /** 0-based, stable across attempts. Appears in the published note, so it must not drift. */
  index: number
  files: MergeRequestDiffFile[]
  diffBytes: number
}

export interface ReviewPlan {
  kind: 'plan'
  chunks: ReviewChunk[]
  excluded: ExcludedFile[]
  diffBytes: number
}

export interface ReviewPlanRefusal {
  kind: 'refused'
  reason: 'nothing_reviewable' | 'too_many_chunks'
  /**
   * Every changed file the planner was handed, INCLUDING the ones it excluded.
   * One meaning for both reasons, deliberately: this counted survivors for
   * `too_many_chunks` and all input for `nothing_reviewable`, so the same field
   * name meant two things depending on why the review was refused. Pair it with
   * `diffBytes`, which counts only material that would have been reviewed, when
   * the distinction matters.
   */
  filesConsidered: number
  diffBytes: number
  chunksRequired: number
  maxChunks: number
}

export type ReviewPlanResult = ReviewPlan | ReviewPlanRefusal

export interface MaterialPlannerOptions {
  excludePaths: string[]
  /** `review.exclude_generated`. Acts on {@link MergeRequestDiffFile.generatedFile}. */
  excludeGenerated: boolean
  /** Soft target per chunk. A single file whose diff exceeds this gets its own oversized chunk. */
  maxChunkBytes: number
  /** Hard ceiling on chunk count. Beyond it the review is refused, never truncated. */
  maxChunks: number
}

// --- self-critique ---------------------------------------------------------

/**
 * What the critic did. `dropped` exists so that reviewer noise — the one
 * failure mode in this design that actually costs anything, and the one thing
 * phase 1 left entirely unmeasured — becomes a number in a log line instead of
 * an impression. It is logged and never published.
 */
export interface CritiqueOutcome {
  ran: boolean
  keptCount: number
  droppedCount: number
  dropped: Array<{ title: string; file: string; reason: string }>
}

export type CritiqueResult =
  | { kind: 'critiqued'; findings: FindingsDocument; outcome: CritiqueOutcome }
  /**
   * The critique could not run — a timeout, an unwritten file, a malformed
   * document, an agent error. NEVER a reason to fail the review: the caller
   * publishes the uncritiqued findings and says so in the note. A flaky second
   * pass must not become zero reviews.
   */
  | { kind: 'unavailable'; reason: string }

export interface FindingsCritic {
  critique(
    request: { findings: FindingsDocument; workspacePath: string; job: ReviewJob },
    signal?: AbortSignal,
  ): Promise<CritiqueResult>
}

// --- optional shallow checkout ---------------------------------------------

export type CheckoutResult =
  | { kind: 'checked_out'; path: string; fileCount: number }
  /** Wider context is a bonus, never a prerequisite — this is not an error path. */
  | { kind: 'unavailable'; reason: string }

export interface RepoCheckout {
  fetch(
    request: { projectId: string; headSha: string; destination: string },
    signal?: AbortSignal,
  ): Promise<CheckoutResult>
}

// --- the work outcome union ------------------------------------------------
//
// MOVED here from review/worker.ts, where it used to live beside the code that
// produces it. It moves because job_runner.ts (which switches on it) and
// worker.ts (which produces it) are built in different waves by different
// slices: leaving the union in worker.ts would have made one file the shared
// contract between two slices that must never edit the same file.
//
// worker.ts re-exports every name below, so existing imports keep working.

export interface ReviewProvenance {
  /** 1 for an unchunked review. Surfaced in the note only when > 1. */
  chunkCount: number
  /** Chunks whose agent run produced nothing usable. Does not fail the review unless ALL did. */
  chunksFailed: number
  excluded: ExcludedFile[]
  /** null means the critique did not run — the note says so rather than implying it passed. */
  critique: CritiqueOutcome | null
  checkoutUsed: boolean
}

export interface ReviewedOutcome {
  kind: 'reviewed'
  findings: FindingsDocument
  /** The files the agent was actually shown. The publisher uses this to catch a finding naming a file outside the review. */
  diffFiles: Array<{ oldPath: string; newPath: string }>
  provenance: ReviewProvenance
}

export interface TooLargeOutcome {
  kind: 'too_large'
  /**
   * Phase 1 had `exceeds_cap` (diff over the byte cap) and `all_collapsed`
   * (every file collapsed). Both are gone: chunking replaced the first, and the
   * material planner folded the second into `nothing_reviewable`, which is the
   * same condition stated in the planner's own vocabulary. Removing them was a
   * compile error at every site that still named one, which is how they were
   * all found.
   */
  reason: 'nothing_reviewable' | 'too_many_chunks'
  filesConsidered: number
  totalBytes: number
  maxDiffBytes: number
}

/** The merge request's head commit had already moved before the review could start. */
export interface StaleOutcome {
  kind: 'stale'
  reason: string
}

export interface FailedOutcome {
  kind: 'failed'
  reason: string
}

/**
 * Tagged union, deliberately: phase 2's chunked review adds variants and
 * fields without reshaping anything that already switches on `.kind`.
 */
export type ReviewWorkOutcome = ReviewedOutcome | TooLargeOutcome | StaleOutcome | FailedOutcome

/**
 * The provenance of a review that was not chunked, not critiqued and had no
 * checkout — phase 1's behaviour, expressed in phase 2's shape. Exists so the
 * default is written once rather than restated at every construction site.
 */
export const UNCHUNKED_PROVENANCE: ReviewProvenance = {
  chunkCount: 1,
  chunksFailed: 0,
  excluded: [],
  critique: null,
  checkoutUsed: false,
}
