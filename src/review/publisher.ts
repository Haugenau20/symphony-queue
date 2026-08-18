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
 *   5. NEW, only when inline comments are enabled: place every finding that
 *      can be tied to a line with certainty, dedup against our own existing
 *      inline threads, and post the rest as new discussions — one at a time,
 *      never in parallel. Anything that cannot be placed, or whose post
 *      fails, falls back to the summary note.
 *   6. post ONE summary note carrying the headSha marker. With inline off it
 *      lists every finding, exactly as before. With inline on it lists only
 *      the findings that fell back, plus one line saying how many went
 *      inline — so a short note still explains itself. Always posted, even
 *      with zero findings: silence must keep meaning "did not run".
 *   7. NEW, only when inline comments are enabled: reply to every one of our
 *      own inline threads that carries an OLDER headSha, naming the new one,
 *      and attempt to resolve it. Logged and swallowed on failure — the
 *      review is already published by this point.
 *
 * The ordering is load-bearing, not cosmetic: swapping 3 and 6 would let a
 * stale review get posted after the code it describes has already changed,
 * dropping 4 would double-post on every retry, running 5 after 6 would leave
 * the note unable to say what went inline, and running 7 before 6 would risk
 * a crash leaving a half-superseded history instead of a published review.
 */

import { getLogger } from '../log.js'
import { safeParseFindingsDocument } from './findings.js'
import {
  assignOrdinals,
  inlineThreadMarker,
  parseInlineThreadMarker,
  placeFinding,
  threadFingerprint,
} from './inline.js'
import type {
  Discussion,
  ExclusionReason,
  Finding,
  FindingsDocument,
  InlinePublishOutcome,
  InlineSkipReason,
  MergeRequestClient,
  MergeRequestDiffFile,
  MergeRequestDiscussionClient,
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
 *
 * Intersected with the full {@link MergeRequestDiscussionClient} (not another
 * `Pick`) — the publisher is the one place in this pipeline allowed to write
 * inline discussions at all, and it needs all four operations — list, create,
 * reply, resolve — to do steps 5 and 7. No other module's client type gains
 * these; `ReviewMaterialClient` (worker.ts) stays exactly as narrow as it
 * always was.
 *
 * The four discussion methods are `Partial` here rather than mandatory: a
 * caller wiring a `ReviewPublisher` with `inlineComments` left off (or a test
 * fixture standing in for GitLab's read/write-note surface only) should not
 * have to invent no-op discussion methods it will never be asked to run.
 * `inlineComments: true` is where the real requirement is enforced — the
 * constructor below checks all four are actually present and throws a clear,
 * immediate error otherwise, rather than let a missing method surface as an
 * opaque `undefined is not a function` the first time step 5 runs.
 */
export type ReviewPublishClient = Pick<
  MergeRequestClient,
  'getMergeRequest' | 'listNotes' | 'createNote' | 'getCurrentUserId'
> &
  Partial<MergeRequestDiscussionClient>

export interface ReviewPublisherConfig {
  mrClient: ReviewPublishClient
  /**
   * Off unless explicitly turned on. The SHIPPED default lives in config.ts
   * (the orchestrator's call, not this module's) — main.ts always passes this
   * explicitly. Defaulting to false here is what makes "an old caller that
   * never mentions this key gets byte-identical output" a property this
   * module can guarantee on its own, rather than one that depends on every
   * caller getting config.ts right.
   */
  inlineComments?: boolean
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
   * The SAME reviewed files, in full — including each one's diff body — for
   * step 5's placement. A separate field from {@link diffFiles} rather than a
   * widened version of it: `diffFiles` is exactly the shape `job_runner.ts`'s
   * `FindingsPublisher` interface (a structural type, not imported from here)
   * already promises to supply, and tightening that field would break every
   * existing caller at the type level. `placementFiles` is additive and
   * OPTIONAL: a caller that has not been updated to supply it simply gets no
   * inline placements — every location-bearing finding reports
   * `file_not_in_diff`, which is an honest, ordinary fallback, never a crash.
   * Ignored entirely when `inlineComments` is off.
   */
  placementFiles?: MergeRequestDiffFile[]
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
  | { status: 'published'; noteId: string; body: string; inline?: InlinePublishOutcome }
  | { status: 'already_published'; noteId: string }
  | { status: 'superseded' }
  | { status: 'rejected'; reason: string }

/**
 * Whether a client actually implements every discussion operation, not just
 * the type-level `Partial` promise of one. A type guard so the constructor
 * can narrow and store a fully-typed reference once, rather than every call
 * site in `publish()` needing its own non-null assertion.
 */
function hasDiscussionMethods(
  client: ReviewPublishClient,
): client is ReviewPublishClient & MergeRequestDiscussionClient {
  return (
    typeof client.listDiscussions === 'function' &&
    typeof client.createDiscussion === 'function' &&
    typeof client.replyToDiscussion === 'function' &&
    typeof client.resolveDiscussion === 'function'
  )
}

/** All-zero, `attempted: false` — step 5a's exact contract when inline is off. */
function emptyInlineOutcome(attempted: boolean): InlinePublishOutcome {
  return {
    attempted,
    placed: 0,
    alreadyPresent: 0,
    fellBack: 0,
    fallbackReasons: {},
    failed: 0,
    superseded: 0,
    resolved: 0,
  }
}

/**
 * The HTTP status off a thrown error, if it looks like one — never the
 * message, and never the error object itself. `GitLabApiError` (gitlab_mr.ts)
 * carries `.status` and builds its `.message` from method/path/status alone,
 * but this module logs neither: an error thrown by some OTHER client
 * implementation (a test fake, a future transport) is not guaranteed to keep
 * that same discipline, and this is the one place credentials or a response
 * body could otherwise leak into a log line.
 */
function errorStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

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

// --- escaping model-authored text (step 5's rendering) -------------------------
//
// Everything the renderer interpolates — the summary, and every finding's
// title, detail, suggestion and file — is MODEL OUTPUT derived from a diff the
// merge request's author wrote. GitLab renders note bodies as markdown WITH RAW
// HTML ENABLED, so none of it can go in unescaped.
//
// This is not cosmetic. A live review of a file with an HTML-injection bug
// quoted the payload it had found, GitLab parsed that payload as real HTML, and
// an unterminated construct swallowed the remaining twelve findings: the note
// said "Blocking (14)" and displayed two. What happened there by accident is
// available on purpose — a merge request crafted so the reviewer quotes hostile
// text back can make its own review render clean, which is an attack on the one
// output this pipeline exists to produce.

/** Neutralises every construct GitLab would parse as HTML, including comment openers. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One line of model prose. HTML is neutralised, and `[`/`]` with it: a finding
 * is otherwise free to render `[click here](http://…)` into a comment a
 * colleague is meant to trust.
 */
function inlineText(text: string): string {
  return escapeHtml(text).replace(/[[\]]/g, (c) => `\\${c}`)
}

/**
 * Model text placed inside `**…**`. Forced onto one line, and `*`/`_`/backtick
 * escaped as well — any of them ends the bold early and puts the rest of the
 * title into the document as markup.
 */
function boldText(text: string): string {
  return inlineText(text.replace(/\s*\r?\n\s*/g, ' ')).replace(/[*_`]/g, (c) => `\\${c}`)
}

/**
 * Multi-line model prose sitting under a list item. Each line is escaped and
 * re-indented to stay inside the item, and any line that would OPEN a block —
 * a fence, a heading, a quote, a nested list — has that opener escaped. A stray
 * ``` in a detail would otherwise turn the rest of the note into a code block.
 */
function blockText(text: string, indent: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) =>
      inlineText(line).replace(/^(\s*)(```|~~~|#{1,6}\s|>|\d+[.)]\s|[-+*]\s)/, (_m, ws: string, tok: string) => `${ws}\\${tok}`),
    )
    .join(`\n${indent}`)
}

/**
 * A file path inside a code span. Deliberately NOT html-escaped: a code span
 * renders its contents literally, so `<` is already inert there and `&lt;`
 * would display as those five characters. The only way out of a code span is a
 * backtick, so the fence is made longer than the longest run inside it — the
 * rule CommonMark itself specifies — and a newline is flattened, since a code
 * span cannot contain one.
 */
function codeSpan(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ')
  const longest = (flat.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

const SEVERITY_SECTIONS: Array<{ severity: Finding['severity']; label: string }> = [
  { severity: 'blocking', label: 'Blocking' },
  { severity: 'concern', label: 'Concern' },
  { severity: 'nit', label: 'Minor' },
]

/**
 * Renders the note body from a validated {@link FindingsDocument} and the
 * headSha alone. No parameter here can carry merge-request-authored text —
 * the summary and every finding field came out of FINDINGS.json, which is
 * the agent's own output, already schema-validated by the time this runs.
 *
 * `extraLine`, when given, is inserted as its own paragraph right after the
 * summary and before the findings — step 6's "N findings posted inline"
 * line. It is OPTIONAL and every existing caller omits it, which is what
 * keeps this function's output byte-identical to what it always produced
 * for those callers: the inline-off acceptance test depends on that.
 * `extraLine` is always OUR OWN generated text (a count), never
 * merge-request-authored, so it is written through as-is rather than run
 * through the escaping helpers below.
 */
export function renderReviewNote(findings: FindingsDocument, headSha: string, extraLine?: string): string {
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
  lines.push(findings.summary.trim().length > 0 ? blockText(findings.summary, '') : '_(no summary provided)_')
  lines.push('')
  if (extraLine !== undefined) {
    lines.push(extraLine)
    lines.push('')
  }

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
        lines.push(`- **${boldText(f.title)}** — ${codeSpan(location)}`)
        lines.push(`  ${blockText(f.detail, '  ')}`)
        if (f.suggestion) lines.push(`  Suggestion: ${blockText(f.suggestion, '  ')}`)
        lines.push('')
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

/**
 * One inline thread's body (step 5's rendering). Lives beside
 * {@link renderReviewNote} because this is where the escaping helpers are —
 * the same discipline applies for the same reason: `finding.title`,
 * `finding.detail` and `finding.suggestion` are model output derived from a
 * diff the merge request's author wrote, and GitLab renders discussion note
 * bodies as markdown with raw HTML enabled exactly as it does summary notes.
 * Title through `boldText`, detail and suggestion through `blockText`.
 *
 * Deliberately omits `finding.file` and the line number: GitLab renders the
 * anchor itself, so repeating the location is both noise and — since
 * `finding.file` is model output — attacker-influenced text with nothing to
 * gain by including it.
 */
export function renderInlineDiscussionBody(finding: Finding, headSha: string, fingerprint: string): string {
  const lines: string[] = []
  lines.push(inlineThreadMarker(headSha, fingerprint))
  lines.push('')
  lines.push(`**${boldText(finding.title)}**`)
  lines.push('')
  lines.push(blockText(finding.detail, ''))
  if (finding.suggestion) {
    lines.push('')
    lines.push(`Suggestion: ${blockText(finding.suggestion, '')}`)
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Step 7's reply to a prior-revision thread. STATIC text plus a head SHA —
 * nothing else. The SHA is our own job's identity, not merge-request-authored
 * text, but it is still wrapped in a code span rather than trusted verbatim:
 * defence in depth costs one function call here, and every other string this
 * module ever sends to GitLab earns its escaping the same way.
 */
function renderSupersededReply(newHeadSha: string): string {
  return `Superseded by a review of the new revision at ${codeSpan(newHeadSha)}. See the new thread(s) posted there.`
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
/**
 * What each exclusion reason means to somebody reading the note, rather than
 * the enum name. "5 binary" reads like an error code; "5 binary (no text diff)"
 * says why nothing was reviewed and that nothing went wrong.
 */
const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  binary: 'binary (no text diff)',
  generated: 'generated',
  exclude_path: 'matched exclude_paths',
  collapsed: 'too large for GitLab to show a diff',
}

/** The same reasons, short enough to sit after a filename. */
const EXCLUSION_SHORT: Record<ExclusionReason, string> = {
  binary: 'binary',
  generated: 'generated',
  exclude_path: 'exclude_paths',
  collapsed: 'too large',
}

/**
 * Filenames are listed, not just counted — knowing WHICH five files were
 * skipped is the difference between "fine, those are icons" and "wait, why was
 * that one skipped".
 *
 * Capped, because an exclude_paths rule matching a vendored directory can
 * exclude hundreds and the note is a comment, not a manifest. Every path goes
 * through `codeSpan`: these come from the diff, so they are chosen by whoever
 * opened the merge request, and a backtick in a filename is the one way out of
 * a code span.
 */
const MAX_LISTED_EXCLUSIONS = 10

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
    lines.push('- Every changed file was reviewed.')
  } else {
    const byReason = new Map<ExclusionReason, number>()
    for (const e of provenance.excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1)
    const breakdown = [...byReason.entries()]
      .map(([reason, count]) => `${count} ${EXCLUSION_LABELS[reason]}`)
      .join(', ')
    lines.push(`- ${excludedCount} file${excludedCount === 1 ? '' : 's'} not reviewed: ${breakdown}.`)
    for (const e of provenance.excluded.slice(0, MAX_LISTED_EXCLUSIONS)) {
      lines.push(`  - ${codeSpan(e.path)} — ${EXCLUSION_SHORT[e.reason]}`)
    }
    const remaining = excludedCount - MAX_LISTED_EXCLUSIONS
    if (remaining > 0) lines.push(`  - …and ${remaining} more.`)
  }

  return lines.join('\n')
}

/**
 * Step 6's one extra line — plain text we generated ourselves (a count), not
 * merge-request-authored, so it needs no escaping. Counts both newly placed
 * threads and ones that already existed for this head SHA (a retry): both
 * are, right now, a live inline comment on the merge request, which is what
 * "went inline" means to a reader of the note.
 */
function renderInlineSummaryLine(outcome: InlinePublishOutcome): string {
  const count = outcome.placed + outcome.alreadyPresent
  const finding = count === 1 ? 'finding was' : 'findings were'
  const comment = count === 1 ? 'comment' : 'comments'
  return `_${count} ${finding} posted as inline ${comment} on this revision._`
}

// --- publisher ------------------------------------------------------------

export class ReviewPublisher {
  private readonly mrClient: ReviewPublishClient
  private readonly inlineComments: boolean
  /**
   * Set only when `inlineComments` is on, after confirming the client
   * actually implements the four discussion methods. Steps 5 and 7 read this
   * rather than `this.mrClient` directly, so they never need their own
   * non-null assertion or runtime check.
   */
  private readonly discussions: MergeRequestDiscussionClient | null

  constructor(config: ReviewPublisherConfig) {
    this.mrClient = config.mrClient
    this.inlineComments = config.inlineComments ?? false
    if (this.inlineComments) {
      if (!hasDiscussionMethods(config.mrClient)) {
        throw new Error(
          'ReviewPublisher: inlineComments is enabled but mrClient does not implement ' +
            'listDiscussions/createDiscussion/replyToDiscussion/resolveDiscussion',
        )
      }
      this.discussions = config.mrClient
    } else {
      this.discussions = null
    }
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

    // 4. dedup against an existing marker note — one WE posted.
    //
    // The marker alone is not proof of authorship. It is a fixed string in a
    // note body, so anyone who can comment on the merge request can post
    // `<!-- symphony-review:<sha> -->` themselves, and a substring match would
    // read that as "a previous attempt already succeeded" and publish nothing.
    // That is a one-line way for the author of a change to silence its review,
    // which is worth closing on a pipeline whose entire output is one comment.
    //
    // So the author has to match too. When our own identity cannot be
    // established the check degrades to marker-only rather than failing:
    // not double-posting is the marker's first job, and refusing to publish at
    // all is a worse failure than remaining spoofable in a degraded state.
    const marker = reviewNoteMarker(headSha)
    const notes = await this.mrClient.listNotes(projectId, mrIid)
    const selfId = await this.mrClient.getCurrentUserId()
    const markerNotes = notes.filter((n) => n.body.includes(marker))
    const existing = selfId === null
      ? markerNotes[0]
      : markerNotes.find((n) => n.authorId === selfId)

    if (selfId !== null && markerNotes.length > 0 && !existing) {
      // Somebody else's note carries our marker. Not fatal — we are about to
      // publish the real one — but it is either an impersonation attempt or a
      // second reviewer deployment writing to the same merge request, and both
      // are worth seeing in a log.
      log.warn(
        { projectId, mrIid, foreignMarkerNotes: markerNotes.length },
        'review_marker_note_not_ours',
      )
    }

    if (existing) {
      log.info(
        { projectId, mrIid, noteId: existing.id, authorVerified: selfId !== null },
        'review_publish_already_published',
      )
      return { status: 'already_published', noteId: existing.id }
    }

    // 5. inline placement and posting — only when enabled. Every branch below
    // this `if` makes zero discussion-API calls when it is false, which is
    // what keeps the note byte-identical to the pre-inline output.
    const inline = emptyInlineOutcome(this.inlineComments)
    // Findings that fall back to the summary note: unplaceable, or placeable
    // but their create call threw. In sanitized-list order.
    const fallback: Finding[] = []
    // Our own inline-thread markers, across every headSha, parsed once from a
    // single listDiscussions call and reused by step 7 below — never
    // re-fetched.
    const ourThreads: Array<{ discussionId: string; headSha: string; fingerprint: string }> = []

    if (this.inlineComments) {
      // Set in the constructor whenever inlineComments is true — see its
      // comment. Non-null by construction, but asserted rather than
      // re-checked here so this block reads like the rest of the method.
      const discussionClient = this.discussions!

      const ordinals = assignOrdinals(sanitized.findings)
      const entries = sanitized.findings.map((finding, i) => ({
        index: i,
        finding,
        placement: placeFinding(finding, request.placementFiles ?? [], request.job),
        fingerprint: threadFingerprint(finding, ordinals[i]!),
      }))

      const discussions: Discussion[] = await discussionClient.listDiscussions(projectId, mrIid)

      let foreignThreadCount = 0
      for (const d of discussions) {
        const first = d.notes[0]
        if (!first) continue
        const marker = parseInlineThreadMarker(first.body)
        if (!marker) continue
        // Same discipline as step 4's marker: a thread's first note has to be
        // OURS, not merely carry our marker string, or the author of a change
        // could post one themselves and suppress its own inline review. When
        // our identity is unknown (selfId === null) this degrades to
        // marker-only, exactly as step 4 does, for the same reason: refusing
        // to publish at all is the worse failure.
        if (selfId !== null && first.authorId !== selfId) {
          foreignThreadCount++
          continue
        }
        ourThreads.push({ discussionId: d.id, headSha: marker.headSha, fingerprint: marker.fingerprint })
      }
      if (selfId !== null && foreignThreadCount > 0) {
        log.warn({ projectId, mrIid, foreignThreadCount }, 'review_inline_marker_not_ours')
      }

      const presentAtThisHead = new Set(
        ourThreads.filter((t) => t.headSha === headSha).map((t) => t.fingerprint),
      )

      const severityRank: Record<Finding['severity'], number> = { blocking: 0, concern: 1, nit: 2 }
      const toCreate: typeof entries = []

      for (const entry of entries) {
        if (entry.placement.kind === 'unplaceable') {
          fallback.push(entry.finding)
          inline.fellBack++
          const reason: InlineSkipReason = entry.placement.reason
          inline.fallbackReasons[reason] = (inline.fallbackReasons[reason] ?? 0) + 1
          continue
        }
        if (presentAtThisHead.has(entry.fingerprint)) {
          // Already posted for THIS revision — a retry after a partial
          // failure. Post nothing, and it does not fall back either: it
          // already has a live thread.
          inline.alreadyPresent++
          continue
        }
        toCreate.push(entry)
      }

      // Severity order, then input order — never Promise.all. GitLab rate
      // limits are a real constraint, and creating discussions sequentially
      // is how that is respected rather than discovered in production.
      toCreate.sort((a, b) => severityRank[a.finding.severity] - severityRank[b.finding.severity] || a.index - b.index)

      for (const entry of toCreate) {
        if (entry.placement.kind !== 'placed') continue // narrowed by the filter above; keeps TS happy
        const body = renderInlineDiscussionBody(entry.finding, headSha, entry.fingerprint)
        try {
          await discussionClient.createDiscussion(projectId, mrIid, body, entry.placement.position)
          inline.placed++
        } catch (err) {
          // A create that throws does not fail the publish — it falls back to
          // the summary note instead. A finding that reaches nobody because a
          // POST 500'd is the one outcome worse than a fallback. Logged with
          // the status only: never the message, never the body.
          inline.failed++
          fallback.push(entry.finding)
          log.warn(
            { projectId, mrIid, status: errorStatus(err) },
            'review_inline_discussion_create_failed',
          )
        }
      }
    }

    // 6. post ONE summary note, always — even with zero findings, so silence
    // unambiguously means the reviewer did not run. With inline off it lists
    // every finding, exactly as it always has. With inline on it lists only
    // the findings that fell back, plus one line saying how many went inline.
    // The provenance footer (if any) is appended after, never changing step
    // order or the findings rendering above it.
    const notedFindings: FindingsDocument = this.inlineComments
      ? { summary: sanitized.summary, findings: fallback }
      : sanitized
    const extraLine = this.inlineComments ? renderInlineSummaryLine(inline) : undefined
    const noteBody = renderReviewNote(notedFindings, headSha, extraLine)
    const body = request.provenance ? `${noteBody}\n${renderProvenanceFooter(request.provenance)}\n` : noteBody
    const noteId = await this.mrClient.createNote(projectId, mrIid, body)
    log.info(
      { projectId, mrIid, noteId, findingCount: sanitized.findings.length, inlinePlaced: inline.placed },
      'review_published',
    )

    // 7. supersede prior-revision threads — only when enabled, and only after
    // the note above is safely posted. A crash between 6 and 7 must leave a
    // published review, never a half-superseded history: superseding is
    // tidying, and tidying is what is sacrificed on a partial failure. Never
    // edits the original note or recomputes its position — a thread anchored
    // to an old revision stays exactly where GitLab put it.
    if (this.inlineComments) {
      const discussionClient = this.discussions!
      for (const thread of ourThreads) {
        if (thread.headSha === headSha) continue // this revision, not a prior one
        try {
          await discussionClient.replyToDiscussion(projectId, mrIid, thread.discussionId, renderSupersededReply(headSha))
          inline.superseded++
        } catch (err) {
          // Logged and swallowed: the review is already published, and
          // failing the job now would only retry a publish that already
          // succeeded.
          log.warn(
            { projectId, mrIid, discussionId: thread.discussionId, status: errorStatus(err) },
            'review_inline_supersede_reply_failed',
          )
          continue
        }
        try {
          const resolved = await discussionClient.resolveDiscussion(projectId, mrIid, thread.discussionId)
          if (resolved) inline.resolved++
        } catch (err) {
          log.warn(
            { projectId, mrIid, discussionId: thread.discussionId, status: errorStatus(err) },
            'review_inline_supersede_resolve_failed',
          )
        }
      }
    }

    return { status: 'published', noteId, body, inline }
  }
}
