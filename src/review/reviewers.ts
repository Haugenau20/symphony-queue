import type { ReviewReviewerConfig } from '../config.js'
import type {
  Finding,
  FindingsDocument,
  ReviewChunk,
  ReviewFanoutProvenance,
  SkippedReviewerProvenance,
} from './types.js'

/** The reviewer profiles selected for one material plan. */
export interface ReviewerSelection {
  /** Eligible profiles in their configuration order. */
  eligible: ReviewReviewerConfig[]
  /** Ineligible profiles in their configuration order. */
  skipped: SkippedReviewerProvenance[]
}

/**
 * One independently runnable reviewer session.
 *
 * The indexes are explicit so aggregation stays deterministic even when
 * parallel promises settle in an arbitrary order.
 */
export interface ReviewerTask {
  reviewer: ReviewReviewerConfig
  reviewerIndex: number
  chunk: ReviewChunk
}

export type ReviewerTaskResult =
  | { kind: 'succeeded'; task: ReviewerTask; findings: FindingsDocument }
  | { kind: 'failed'; task: ReviewerTask; reason: string }

export interface ReviewerAggregation {
  findings: FindingsDocument
  provenance: ReviewFanoutProvenance
}

/**
 * Select profiles using only the final material chunk count. The primary
 * reviewer's lack of a ceiling is enforced by configuration validation; this
 * pure helper applies the same eligibility rule to every profile.
 */
export function selectReviewers(
  reviewers: readonly ReviewReviewerConfig[],
  chunkCount: number,
): ReviewerSelection {
  const eligible: ReviewReviewerConfig[] = []
  const skipped: SkippedReviewerProvenance[] = []

  for (const reviewer of reviewers) {
    if (reviewer.maxChunks !== null && chunkCount > reviewer.maxChunks) {
      skipped.push({
        reviewerId: reviewer.id,
        reason: 'max_chunks_exceeded',
        maxChunks: reviewer.maxChunks,
      })
    } else {
      eligible.push(reviewer)
    }
  }

  return { eligible, skipped }
}

/**
 * Produce the fan-out matrix in configuration-reviewer order, then stable
 * chunk order. `reviewerIndex` refers to the eligible/configuration order and
 * is retained on each result so completion order cannot affect publication.
 */
export function planReviewerTasks(
  selection: ReviewerSelection,
  chunks: readonly ReviewChunk[],
): ReviewerTask[] {
  const orderedChunks = [...chunks].sort((a, b) => a.index - b.index)
  return selection.eligible.flatMap((reviewer, reviewerIndex) =>
    orderedChunks.map((chunk) => ({ reviewer, reviewerIndex, chunk })),
  )
}

function compareTasks(a: ReviewerTask, b: ReviewerTask): number {
  return a.reviewerIndex - b.reviewerIndex || a.chunk.index - b.chunk.index
}

/**
 * Exact means exact: every published field must match. In particular, two
 * findings about the same file and line with different wording are candidates
 * for the critic, not mechanical duplicates.
 */
function exactFindingKey(finding: Finding): string {
  return JSON.stringify([
    finding.severity,
    finding.file,
    finding.line,
    finding.lineType,
    finding.title,
    finding.detail,
    finding.suggestion,
  ])
}

export interface ExactDeduplicationResult {
  findings: Finding[]
  removed: number
}

/** Remove fully identical findings while preserving the first occurrence. */
export function removeExactDuplicateFindings(
  findings: readonly Finding[],
): ExactDeduplicationResult {
  const seen = new Set<string>()
  const unique: Finding[] = []

  for (const finding of findings) {
    const key = exactFindingKey(finding)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(finding)
  }

  return { findings: unique, removed: findings.length - unique.length }
}

function mergeSuccessfulDocuments(
  successes: Array<Extract<ReviewerTaskResult, { kind: 'succeeded' }>>,
): { findings: FindingsDocument; candidateFindingCount: number; exactDuplicatesRemoved: number } {
  if (successes.length === 0) {
    return {
      findings: { summary: '(no summary provided)', findings: [] },
      candidateFindingCount: 0,
      exactDuplicatesRemoved: 0,
    }
  }

  const candidates = successes.flatMap((result) => result.findings.findings)
  const deduplicated = removeExactDuplicateFindings(candidates)

  // Preserve the old one-session document shape exactly. Besides avoiding
  // needless presentation drift, this keeps the default configuration fully
  // backward-compatible.
  let summary: string
  if (successes.length === 1) {
    summary = successes[0]!.findings.summary
  } else {
    const summaries = successes
      .map((result) => {
        const text = result.findings.summary.trim()
        if (text.length === 0) return null
        return `Reviewer ${result.task.reviewer.id}, batch ${result.task.chunk.index + 1}: ${text}`
      })
      .filter((value): value is string => value !== null)
    summary = summaries.length > 0 ? summaries.join('\n') : '(no summary provided)'
  }

  return {
    findings: { summary, findings: deduplicated.findings },
    candidateFindingCount: candidates.length,
    exactDuplicatesRemoved: deduplicated.removed,
  }
}

/**
 * Consolidate settled session results into one critic input and its fan-out
 * provenance. Results are sorted by their task coordinates, so caller
 * completion order never leaks into findings or summaries.
 */
export function aggregateReviewerResults(
  tasks: readonly ReviewerTask[],
  results: readonly ReviewerTaskResult[],
  selection: ReviewerSelection,
): ReviewerAggregation {
  const orderedResults = [...results].sort((a, b) => compareTasks(a.task, b.task))
  const successes = orderedResults.filter(
    (result): result is Extract<ReviewerTaskResult, { kind: 'succeeded' }> => result.kind === 'succeeded',
  )
  const failures = orderedResults.filter(
    (result): result is Extract<ReviewerTaskResult, { kind: 'failed' }> => result.kind === 'failed',
  )
  const merged = mergeSuccessfulDocuments(successes)

  const coveredChunks = new Set(successes.map((result) => result.task.chunk.index))
  const plannedChunkIndexes = [...new Set(tasks.map((task) => task.chunk.index))].sort((a, b) => a - b)

  return {
    findings: merged.findings,
    provenance: {
      eligibleReviewerIds: selection.eligible.map((reviewer) => reviewer.id),
      skippedReviewers: [...selection.skipped],
      sessionsPlanned: tasks.length,
      sessionsSucceeded: successes.length,
      sessionsFailed: failures.length,
      failedSessions: failures.map((result) => ({
        reviewerId: result.task.reviewer.id,
        chunkIndex: result.task.chunk.index,
      })),
      candidateFindingCount: merged.candidateFindingCount,
      exactDuplicatesRemoved: merged.exactDuplicatesRemoved,
      uncoveredChunkIndexes: plannedChunkIndexes.filter((index) => !coveredChunks.has(index)),
    },
  }
}
