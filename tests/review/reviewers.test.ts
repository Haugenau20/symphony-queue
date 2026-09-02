import { describe, expect, it } from 'vitest'
import type { ReviewReviewerConfig } from '../../src/config.js'
import {
  aggregateReviewerResults,
  planReviewerTasks,
  removeExactDuplicateFindings,
  selectReviewers,
  type ReviewerTask,
  type ReviewerTaskResult,
} from '../../src/review/reviewers.js'
import type { Finding, FindingsDocument, ReviewChunk } from '../../src/review/types.js'

const reviewers: ReviewReviewerConfig[] = [
  { id: 'general', primary: true, instructions: 'Broad review.', maxChunks: null },
  { id: 'security', primary: false, instructions: 'Security review.', maxChunks: 2 },
  { id: 'reliability', primary: false, instructions: 'Reliability review.', maxChunks: 2 },
  { id: 'always_on', primary: false, instructions: 'Domain review.', maxChunks: null },
]

function chunks(count: number): ReviewChunk[] {
  return Array.from({ length: count }, (_, index) => ({ index, files: [], diffBytes: index + 1 }))
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'concern',
    file: 'src/a.ts',
    line: 10,
    lineType: 'added',
    title: 'Unchecked value',
    detail: 'The value can be null here.',
    suggestion: 'Guard it first.',
    ...overrides,
  }
}

function document(summary: string, findings: Finding[]): FindingsDocument {
  return { summary, findings }
}

function succeed(task: ReviewerTask, findings: FindingsDocument): ReviewerTaskResult {
  return { kind: 'succeeded', task, findings }
}

describe('selectReviewers', () => {
  it.each([1, 2])('selects all profiles for a %i-chunk plan', (chunkCount) => {
    const selection = selectReviewers(reviewers, chunkCount)

    expect(selection.eligible.map((reviewer) => reviewer.id)).toEqual([
      'general', 'security', 'reliability', 'always_on',
    ])
    expect(selection.skipped).toEqual([])
  })

  it('skips only capped supplemental profiles above their chunk ceiling', () => {
    const selection = selectReviewers(reviewers, 3)

    expect(selection.eligible.map((reviewer) => reviewer.id)).toEqual(['general', 'always_on'])
    expect(selection.skipped).toEqual([
      { reviewerId: 'security', reason: 'max_chunks_exceeded', maxChunks: 2 },
      { reviewerId: 'reliability', reason: 'max_chunks_exceeded', maxChunks: 2 },
    ])
  })
})

describe('planReviewerTasks', () => {
  it('orders the matrix by configured reviewer, then by chunk index', () => {
    const selection = selectReviewers(reviewers.slice(0, 3), 2)
    // Deliberately supply chunks out of order: their stable indexes, not array
    // arrival order, define deterministic publication order.
    const tasks = planReviewerTasks(selection, [chunks(2)[1]!, chunks(2)[0]!])

    expect(tasks.map((task) => `${task.reviewer.id}:${task.chunk.index}`)).toEqual([
      'general:0', 'general:1',
      'security:0', 'security:1',
      'reliability:0', 'reliability:1',
    ])
  })

  it('makes one task per eligible reviewer/chunk pair', () => {
    const selection = selectReviewers(reviewers, 3)
    expect(planReviewerTasks(selection, chunks(3))).toHaveLength(6)
  })
})

describe('removeExactDuplicateFindings', () => {
  it('removes fully identical findings and preserves the first object', () => {
    const first = finding()
    const duplicate = { ...first }
    const distinct = finding({ detail: 'Different wording about the same possible issue.' })

    const result = removeExactDuplicateFindings([first, duplicate, distinct])

    expect(result.findings).toEqual([first, distinct])
    expect(result.findings[0]).toBe(first)
    expect(result.removed).toBe(1)
  })

  it.each([
    finding({ severity: 'blocking' }),
    finding({ file: 'src/b.ts' }),
    finding({ line: 11 }),
    finding({ lineType: 'context' }),
    finding({ title: 'Different title' }),
    finding({ detail: 'Different detail' }),
    finding({ suggestion: null }),
  ])('preserves a candidate when any finding field differs', (different) => {
    expect(removeExactDuplicateFindings([finding(), different])).toEqual({
      findings: [finding(), different],
      removed: 0,
    })
  })
})

describe('aggregateReviewerResults', () => {
  it('is deterministic despite out-of-order completion and exactly deduplicates before critique', () => {
    const selection = selectReviewers(reviewers.slice(0, 2), 2)
    const tasks = planReviewerTasks(selection, chunks(2))
    const shared = finding()
    const generalOnly = finding({ title: 'General-only issue' })
    const securityOnly = finding({ title: 'Security-only issue' })

    const results: ReviewerTaskResult[] = [
      succeed(tasks[3]!, document('security second', [securityOnly])),
      succeed(tasks[1]!, document('general second', [shared])),
      succeed(tasks[2]!, document('security first', [{ ...shared }])),
      succeed(tasks[0]!, document('general first', [generalOnly])),
    ]

    const aggregated = aggregateReviewerResults(tasks, results, selection)

    expect(aggregated.findings).toEqual({
      summary: [
        'Reviewer general, batch 1: general first',
        'Reviewer general, batch 2: general second',
        'Reviewer security, batch 1: security first',
        'Reviewer security, batch 2: security second',
      ].join('\n'),
      findings: [generalOnly, shared, securityOnly],
    })
    expect(aggregated.provenance).toEqual({
      eligibleReviewerIds: ['general', 'security'],
      skippedReviewers: [],
      sessionsPlanned: 4,
      sessionsSucceeded: 4,
      sessionsFailed: 0,
      failedSessions: [],
      candidateFindingCount: 4,
      exactDuplicatesRemoved: 1,
      uncoveredChunkIndexes: [],
    })
  })

  it('computes failures and uncovered chunks from successful task results', () => {
    const selection = selectReviewers(reviewers.slice(0, 2), 3)
    const tasks = planReviewerTasks(selection, chunks(3))
    const results: ReviewerTaskResult[] = [
      succeed(tasks[0]!, document('chunk zero', [])),
      { kind: 'failed', task: tasks[1]!, reason: 'agent failed' },
      { kind: 'failed', task: tasks[2]!, reason: 'agent failed' },
    ]

    const aggregated = aggregateReviewerResults(tasks, results, selection)

    expect(aggregated.provenance).toEqual({
      eligibleReviewerIds: ['general'],
      skippedReviewers: [
        { reviewerId: 'security', reason: 'max_chunks_exceeded', maxChunks: 2 },
      ],
      sessionsPlanned: 3,
      sessionsSucceeded: 1,
      sessionsFailed: 2,
      failedSessions: [
        { reviewerId: 'general', chunkIndex: 1 },
        { reviewerId: 'general', chunkIndex: 2 },
      ],
      candidateFindingCount: 0,
      exactDuplicatesRemoved: 0,
      uncoveredChunkIndexes: [1, 2],
    })
  })

  it('preserves the sole successful findings document summary unchanged', () => {
    const selection = selectReviewers(reviewers.slice(0, 1), 1)
    const tasks = planReviewerTasks(selection, chunks(1))
    const original = document(' Original summary with spacing. ', [finding()])

    expect(aggregateReviewerResults(tasks, [succeed(tasks[0]!, original)], selection).findings).toEqual(original)
  })

  it('preserves similar non-identical findings for semantic critique', () => {
    const selection = selectReviewers(reviewers.slice(0, 2), 1)
    const tasks = planReviewerTasks(selection, chunks(1))
    const first = finding({ detail: 'Null is possible.' })
    const second = finding({ detail: 'This input may be absent.' })

    const aggregated = aggregateReviewerResults(tasks, [
      succeed(tasks[0]!, document('general', [first])),
      succeed(tasks[1]!, document('security', [second])),
    ], selection)

    expect(aggregated.findings.findings).toEqual([first, second])
    expect(aggregated.provenance.exactDuplicatesRemoved).toBe(0)
  })
})
