/**
 * The only component in this pipeline that writes to GitLab. Everything it
 * publishes is derived from a validated {@link FindingsDocument} and the
 * merge request's identity (project, iid, headSha) — never from merge-request
 * -authored text. The title/description an attacker controls never reaches
 * this module at all: {@link PublishRequest} has no field for it.
 *
 * Sequence, in this exact order, every time:
 *
 *   1. validate the findings document — reject on failure. A malformed run
 *      is a failed run, not a partial publish: nothing below this step runs.
 *   2. drop or downgrade findings naming a file absent from the diff the
 *      agent was actually shown.
 *   3. RE-FETCH the merge request and compare headSha. Changed -> mark
 *      superseded and publish NOTHING. This is a live check, not reused from
 *      whatever the worker saw — the worker may have finished minutes ago.
 *   4. list existing notes; a note already carrying this headSha's marker
 *      means a previous attempt already succeeded — record and stop.
 *   5. post ONE summary note carrying that marker; return its id.
 *
 * The ordering is load-bearing, not cosmetic: swapping 3 and 5 would let a
 * stale review get posted after the code it describes has already changed,
 * and dropping 4 would double-post on every retry.
 */

import { getLogger } from '../log.js'
import { safeParseFindingsDocument } from './findings.js'
import type {
  Finding,
  FindingsDocument,
  MergeRequestClient,
  MergeRequestSummary,
  ReviewJob,
  ReviewProvenance,
} from './types.js'

// --- public types -----------------------------------------------------------

/**
 * What the publisher needs. Deliberately narrower than the full
 * {@link MergeRequestClient}: no `listDiffs` / `getFileAtRef`, so it is a
 * compile-time error for this module to go fetch its own material — it only
 * ever acts on what {@link PublishRequest} was handed.
 */
export type ReviewPublishClient = Pick<MergeRequestClient, 'getMergeRequest' | 'listNotes' | 'createNote'>

export interface ReviewPublisherConfig {
  mrClient: ReviewPublishClient
}

export interface PublishRequest {
  job: ReviewJob
  /**
   * The candidate findings, in whatever shape they arrived in — parsed JSON,
   * or already a well-typed {@link FindingsDocument}. Always re-validated
   * here (step 1) regardless: this module is the last line of defense before
   * anything reaches GitLab, so it never trusts an upstream caller's claim
   * that a value was already checked.
   */
  findings: unknown
  /** The files the review agent actually saw (design: worker's `diffFiles`). Used by step 2. */
  diffFiles: Array<{ oldPath: string; newPath: string }>
  /**
   * OPTIONAL, so the existing `FindingsPublisher` caller in job_runner.ts
   * (which does not construct one) keeps compiling unchanged. When present,
   * renders as a short footer below the findings (step 5) — see
   * {@link renderProvenanceFooter}.
   *
   * Read that renderer before adding anything to this footer. What makes this
   * parameter safe is NOT that ReviewProvenance holds only trusted data — it
   * does not. `excluded[].path` is a diff file path, which comes from the
   * merge request and is exactly as attacker-controlled as its title. What
   * makes it safe is that the renderer emits COUNTS and exclusion REASONS and
   * never a path. Rendering `excluded[].path` would put attacker-authored text
   * into a published note, through a parameter added for provenance.
   */
  provenance?: ReviewProvenance | null
}

export type PublishResult =
  | { status: 'published'; noteId: string; body: string }
  | { status: 'already_published'; noteId: string }
  | { status: 'superseded' }
  | { status: 'rejected'; reason: string }

// --- marker -------------------------------------------------------------------

export function reviewNoteMarker(headSha: string): string {
  return `<!-- symphony-review:${headSha} -->`
}

// --- finding sanitization (step 2) --------------------------------------------

/**
 * A finding naming a file the diff doesn't contain is either a hallucination
 * or a stale path from a rename/normalization mismatch — either way it is
 * not something to post at its claimed severity. It is downgraded rather
 * than silently dropped: dropping it would erase evidence of a real problem
 * (the agent may just have the wrong filename for a genuine issue), while
 * publishing it unchanged would let an unverifiable claim carry the same
 * weight as a checked one. Downgrading keeps it visible, at the bottom of the
 * list, clearly marked as unverified.
 */
export function sanitizeFindings(
  findings: Finding[],
  diffFiles: Array<{ oldPath: string; newPath: string }>,
): Finding[] {
  const known = new Set<string>()
  for (const f of diffFiles) {
    known.add(f.oldPath)
    known.add(f.newPath)
  }
  return findings.map((finding) => {
    if (known.has(finding.file)) return finding
    return {
      ...finding,
      severity: 'nit',
      title: `[unverified file] ${finding.title}`,
      detail:
        `This finding names "${finding.file}", which is not among the files in the reviewed diff. ` +
        `Downgraded automatically and should be treated with caution.\n\n${finding.detail}`,
    }
  })
}

// --- rendering ----------------------------------------------------------------

const SEVERITY_SECTIONS: Array<{ severity: Finding['severity']; label: string }> = [
  { severity: 'blocking', label: 'Blocking' },
  { severity: 'concern', label: 'Concern' },
  { severity: 'nit', label: 'Nit' },
]

/**
 * Renders the note body from a validated {@link FindingsDocument} and the
 * headSha alone. No parameter here can carry merge-request-authored text —
 * the summary and every finding field came out of FINDINGS.json, which is
 * the agent's own output, already schema-validated by the time this runs.
 */
export function renderReviewNote(findings: FindingsDocument, headSha: string): string {
  const bySeverity = new Map<Finding['severity'], Finding[]>()
  for (const { severity } of SEVERITY_SECTIONS) bySeverity.set(severity, [])
  for (const finding of findings.findings) {
    bySeverity.get(finding.severity)!.push(finding)
  }

  const lines: string[] = []
  lines.push(reviewNoteMarker(headSha))
  lines.push('')
  lines.push('## Symphony automated review')
  lines.push('')
  lines.push(findings.summary.trim().length > 0 ? findings.summary : '_(no summary provided)_')
  lines.push('')

  if (findings.findings.length === 0) {
    lines.push('No findings.')
  } else {
    for (const { severity, label } of SEVERITY_SECTIONS) {
      const items = bySeverity.get(severity)!
      if (items.length === 0) continue
      lines.push(`### ${label} (${items.length})`)
      lines.push('')
      for (const f of items) {
        const location = f.line !== null ? `${f.file}:${f.line}` : f.file
        lines.push(`- **${f.title}** — \`${location}\``)
        lines.push(`  ${f.detail}`)
        if (f.suggestion) lines.push(`  Suggestion: ${f.suggestion}`)
        lines.push('')
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

/**
 * The provenance footer (design §12: this must be visible to the reader, not
 * hidden). Every value it renders comes from {@link ReviewProvenance} —
 * chunk counts, exclusion reasons, a critic's kept/dropped counts — never
 * from `job.title`, `job` description text, or anything else that could
 * carry merge-request-authored content. Appended below the findings, never
 * touching step order or the sanitization/head-SHA-recheck steps above it.
 *
 * The chunk line is the ONE conditional element — design §12 only requires
 * the split to be visible "when more than one", so an unchunked (or
 * single-chunk) review's note has no chunk line at all. Whether the
 * self-critique ran is stated unconditionally, in both directions: silence
 * on that point would read as "it must have passed" to anyone who does not
 * already know this pipeline has an optional second pass.
 */
export function renderProvenanceFooter(provenance: ReviewProvenance): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('')
  lines.push('**Review notes**')

  if (provenance.chunkCount > 1) {
    const failedSuffix =
      provenance.chunksFailed > 0
        ? ` (${provenance.chunksFailed} of ${provenance.chunkCount} failed and were not included)`
        : ''
    lines.push(`- Diff reviewed in ${provenance.chunkCount} batches${failedSuffix}.`)
  }

  if (provenance.critique) {
    lines.push(
      `- Self-critique ran: kept ${provenance.critique.keptCount}, dropped ${provenance.critique.droppedCount}.`,
    )
  } else {
    lines.push('- Self-critique did not run.')
  }

  const excludedCount = provenance.excluded.length
  if (excludedCount === 0) {
    lines.push('- No files excluded.')
  } else {
    const byReason = new Map<string, number>()
    for (const e of provenance.excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1)
    const breakdown = [...byReason.entries()].map(([reason, count]) => `${count} ${reason}`).join(', ')
    lines.push(`- ${excludedCount} file${excludedCount === 1 ? '' : 's'} excluded: ${breakdown}.`)
  }

  return lines.join('\n')
}

// --- publisher ------------------------------------------------------------

export class ReviewPublisher {
  private readonly mrClient: ReviewPublishClient

  constructor(config: ReviewPublisherConfig) {
    this.mrClient = config.mrClient
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const log = getLogger()
    const { projectId, mrIid, headSha } = request.job.key

    // 1. validate — reject on failure, nothing below this line runs.
    const parsed = safeParseFindingsDocument(request.findings)
    if (!parsed.success) {
      log.warn({ projectId, mrIid, error: parsed.error }, 'review_publish_rejected_malformed_findings')
      return { status: 'rejected', reason: parsed.error }
    }

    // 2. drop or downgrade findings naming a file outside the reviewed diff.
    const sanitized: FindingsDocument = {
      summary: parsed.data.summary,
      findings: sanitizeFindings(parsed.data.findings, request.diffFiles),
    }

    // 3. re-fetch and compare headSha. This is a LIVE call — never reuse a
    // headSha the worker observed earlier, since the whole point is to catch
    // a commit that landed after the review ran.
    const fresh: MergeRequestSummary | null = await this.mrClient.getMergeRequest(projectId, mrIid)
    if (!fresh || fresh.headSha !== headSha) {
      log.info(
        { projectId, mrIid, reviewedSha: headSha, currentSha: fresh?.headSha ?? null },
        'review_publish_superseded',
      )
      return { status: 'superseded' }
    }

    // 4. dedup against an existing marker note.
    const marker = reviewNoteMarker(headSha)
    const notes = await this.mrClient.listNotes(projectId, mrIid)
    const existing = notes.find((n) => n.body.includes(marker))
    if (existing) {
      log.info({ projectId, mrIid, noteId: existing.id }, 'review_publish_already_published')
      return { status: 'already_published', noteId: existing.id }
    }

    // 5. post ONE summary note, always — even with zero findings, so silence
    // unambiguously means the reviewer did not run. The provenance footer
    // (if any) is appended here, after the findings body is fully rendered —
    // it never changes step order or the findings rendering above it.
    const noteBody = renderReviewNote(sanitized, headSha)
    const body = request.provenance ? `${noteBody}\n${renderProvenanceFooter(request.provenance)}\n` : noteBody
    const noteId = await this.mrClient.createNote(projectId, mrIid, body)
    log.info({ projectId, mrIid, noteId, findingCount: sanitized.findings.length }, 'review_published')
    return { status: 'published', noteId, body }
  }
}
