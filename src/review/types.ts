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

// ===========================================================================
// PHASE 3 — validated inline diff discussions
//
// Same rule as phases 1 and 2: implemented and consumed by slices running in
// different waves, so this is FROZEN for their duration. A signature that is
// wrong is reported, not edited.
//
// The whole of this phase is one sentence long: a finding that can be tied to
// a line WITH CERTAINTY becomes a comment on that line, and everything else
// goes in the summary note exactly as it does today. Design §1 calls a wrongly
// positioned comment the highest-risk failure in the plan — it is visible,
// wrong, and on someone else's merge request — so every type below is shaped
// to make "I could not place this" an ordinary, cheap, frequently-taken answer
// rather than an error path somebody is tempted to route around.
// ===========================================================================

/**
 * GitLab's inline-comment position contract, complete and in one place.
 *
 * All eight fields, every time. The three SHAs come from {@link ReviewJob},
 * BOTH paths come from the {@link MergeRequestDiffFile} the finding was
 * resolved against — never from the finding's own `file` string, which is
 * model output — `positionType` is always `'text'`, and the two line numbers
 * come from diff.ts's `positionFor`, whose per-line-type contract is the half
 * of this that already exists and is already tested.
 *
 * `oldLine` / `newLine` follow that contract exactly, and the transport
 * serialises a null by OMITTING the key rather than sending an explicit
 * `null`: GitLab rejects a null where it expects an absent key, and the
 * difference is invisible to any test that asserts on a parsed object instead
 * of on the serialised body.
 */
export interface DiscussionPosition {
  baseSha: string
  startSha: string
  headSha: string
  oldPath: string
  newPath: string
  positionType: 'text'
  /** Present for a removed or context line; null for an added one. */
  oldLine: number | null
  /** Present for an added or context line; null for a removed one. */
  newLine: number | null
}

export interface DiscussionNote {
  id: string
  body: string
  /**
   * The same discipline the summary-note marker gained in phase 2, for the
   * same reason: a marker is a fixed string in a body, so anyone who can
   * comment can paste one. Matching a thread on its marker alone would let the
   * author of a change suppress its own inline review. Null when the instance
   * did not report an author, which is treated as "not ours".
   */
  authorId: string | null
  /** Null for a discussion note that is not anchored to a diff line. */
  position: {
    oldPath: string
    newPath: string
    oldLine: number | null
    newLine: number | null
  } | null
}

export interface Discussion {
  id: string
  /** Only a resolvable discussion can be resolved; an individual note is not. */
  resolvable: boolean
  resolved: boolean
  notes: DiscussionNote[]
}

/**
 * Why a finding could not be placed on a line.
 *
 * Every one of these is NORMAL and none is a failure. A review in which half
 * the findings fall back to the summary note is a correct review; a review in
 * which one finding lands on the wrong line is not. The names are deliberately
 * specific so the fallback counts are diagnosable — "40% outside_hunk" and
 * "40% file_not_in_diff" call for completely different fixes.
 */
export type InlineSkipReason =
  /** `finding.line` is null — the finding is not about one line at all. */
  | 'no_line'
  /** `finding.file` resolves to no file in the reviewed set. */
  | 'file_not_in_diff'
  /** It resolves to more than one. Refuse; never pick. */
  | 'ambiguous_file'
  /** `positionFor` found no line of the CLAIMED type at that number. */
  | 'outside_hunk'
  /** The job is missing base/start/head — nothing can be positioned. */
  | 'no_diff_refs'

/**
 * A position, or a reason there is none. There is deliberately no third
 * variant: no confidence score, no "best effort" placement, no "probably
 * here". A guess is the one thing this phase exists to prevent.
 */
export type InlinePlacement =
  | { kind: 'placed'; position: DiscussionPosition; fingerprint: string }
  | { kind: 'unplaceable'; reason: InlineSkipReason }

/**
 * What inline publishing did. Reported on the publisher's result and rendered
 * as one line of the note, so a reader who sees a short summary note can tell
 * WHY it is short rather than assuming the reviewer found little.
 *
 * Deliberately NOT part of {@link ReviewProvenance}: provenance is the
 * worker's output and is complete before the publisher runs. Threading this
 * through it would reshape a phase 2 contract and edit worker.ts for no
 * behavioural reason at all.
 */
export interface InlinePublishOutcome {
  /** False when the feature is off. Every count below is then zero. */
  attempted: boolean
  /** New threads actually created at this head SHA. */
  placed: number
  /**
   * Threads that already existed for this exact head SHA and fingerprint —
   * a retry after a partial failure, which is an ordinary case because the
   * summary note is the LAST write and nothing upstream records partial
   * progress through the thread posting.
   */
  alreadyPresent: number
  /** Findings that went into the summary note instead. */
  fellBack: number
  fallbackReasons: Partial<Record<InlineSkipReason, number>>
  /**
   * Threads whose create call failed. These fall back into the note too: a
   * finding that reaches nobody because one POST returned 500 is the one
   * outcome worse than a fallback.
   */
  failed: number
  /** Prior-revision threads replied to. */
  superseded: number
  /**
   * Of those, how many the token was actually PERMITTED to resolve. Whether a
   * Reporter-role token may resolve a discussion it authored is unverified on
   * our instance, so this is how the answer arrives — from the first live run,
   * as a number, rather than from documentation this environment cannot reach.
   */
  resolved: number
}

/**
 * The four discussion operations, deliberately a SEPARATE interface rather
 * than four more methods on {@link MergeRequestClient}.
 *
 * Two reasons, and the second one is why it is worth the extra name:
 *
 *  1. `GitLabMergeRequestClient` declares `implements MergeRequestClient`, so
 *     adding methods there would break the build in the wave that declares
 *     them and unbreak it in the wave that implements them. A contract that
 *     cannot be committed on its own is not a contract.
 *  2. It keeps the capability nameable. The reviewing agent's half of the
 *     pipeline takes `ReviewMaterialClient` (worker.ts), which is a `Pick` of
 *     `MergeRequestClient` and does NOT include this interface — so the worker
 *     still cannot write to GitLab, and still cannot be given the ability by
 *     editing a call site. Only the publisher's client type widens, in
 *     publisher.ts, where it already lives.
 */
export interface MergeRequestDiscussionClient {
  listDiscussions(projectId: string, mrIid: number): Promise<Discussion[]>

  /** Creates a diff-anchored discussion. Returns the new discussion's id. */
  createDiscussion(
    projectId: string,
    mrIid: number,
    body: string,
    position: DiscussionPosition,
  ): Promise<string>

  /** Adds a note to an existing discussion. Returns the new note's id. */
  replyToDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<string>

  /**
   * Attempts to resolve a discussion. Returns false — never throws — when the
   * instance or the token refuses (403/404/405) or the discussion is not
   * resolvable. A 5xx or a transport failure still throws: that is a real
   * fault and hiding it would be wrong.
   *
   * A boolean rather than void, and a refusal rather than an exception,
   * because whether a Reporter-role token can resolve a discussion it authored
   * is UNVERIFIED on our instance. The caller replies FIRST and unconditionally
   * and treats resolution as a bonus, so the reply-only fallback is simply what
   * happens when this returns false — no second code path, no config key, and
   * no architecture riding on an answer nobody has yet.
   */
  resolveDiscussion(projectId: string, mrIid: number, discussionId: string): Promise<boolean>
}
