/**
 * Pure diff parsing and line-position mapping. No I/O, no GitLab knowledge —
 * everything here operates on strings and the fields already present on
 * {@link MergeRequestDiffFile}, so it can be unit tested without a network and
 * reused unchanged by gitlab_mr.ts (mapping raw responses) and, later, by
 * Phase 3's inline-comment publisher.
 *
 * Two things here are easy to get wrong and are called out explicitly in the
 * wave-2 brief, so both get dedicated tests:
 *
 *  - `isCollapsedDiff`: GitLab returns an EMPTY diff body, not an error, when
 *    a file's diff exceeds its size/line limits. An empty diff is therefore
 *    ambiguous on its own — it might mean "collapsed" or it might mean
 *    "genuinely nothing to show" (an already-empty file being deleted, for
 *    instance). Getting this wrong makes the reviewer publish "no changes
 *    found" on a large MR, which is exactly the kind of noise that costs
 *    trust.
 *  - `positionFor`: GitLab's inline-comment position contract requires BOTH
 *    `old_line` and `new_line` for a context (unchanged) line, and only one
 *    of the two for an added or removed line. The context case is the one
 *    implementations most often get wrong by returning just `new_line`.
 */

import type { Finding, MergeRequestDiffFile } from './types.js'

// --- hunk parsing ------------------------------------------------------------

export type DiffLineType = 'added' | 'removed' | 'context'

export interface DiffLine {
  type: DiffLineType
  /** Line number in the pre-image (old) file, or null for an added line. */
  oldLine: number | null
  /** Line number in the post-image (new) file, or null for a removed line. */
  newLine: number | null
  /** The line's content, with the leading +/-/space marker stripped. */
  text: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses a unified diff body (the `diff` field of a GitLab diff file object)
 * into its hunks. Any preamble before the first `@@` header (a `diff --git`
 * line, `index` line, `--- a/...` / `+++ b/...` headers) is tolerated and
 * skipped rather than assumed absent — GitLab's `/diffs` endpoint has been
 * observed to omit it, but nothing here depends on that.
 */
export function parseHunks(diff: string): DiffHunk[] {
  if (!diff) return []

  const rawLines = diff.split('\n')
  // split() on a diff that ends with '\n' (the normal case) leaves a trailing
  // empty element that is not a line of the diff at all; drop it. A '\n\n' in
  // the middle of the text is a real (blank, context) line and must survive.
  if (diff.endsWith('\n')) rawLines.pop()

  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const raw of rawLines) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = {
        oldStart: oldLine,
        oldLines: header[2] !== undefined ? Number(header[2]) : 1,
        newStart: newLine,
        newLines: header[4] !== undefined ? Number(header[4]) : 1,
        lines: [],
      }
      hunks.push(current)
      continue
    }

    if (!current) continue // preamble before the first hunk — not part of any hunk

    if (raw.startsWith('\\')) continue // "\ No newline at end of file" — not a content line

    if (raw.startsWith('+')) {
      current.lines.push({ type: 'added', oldLine: null, newLine, text: raw.slice(1) })
      newLine++
    } else if (raw.startsWith('-')) {
      current.lines.push({ type: 'removed', oldLine, newLine: null, text: raw.slice(1) })
      oldLine++
    } else {
      // Context line. Unified diff prefixes these with a single space, but a
      // genuinely blank context line may arrive as an empty string with
      // nothing to strip.
      const text = raw.startsWith(' ') ? raw.slice(1) : raw
      current.lines.push({ type: 'context', oldLine, newLine, text })
      oldLine++
      newLine++
    }
  }

  return hunks
}

// --- collapsed-diff detection -------------------------------------------------

const BINARY_DIFF_MARKER = /^Binary files .* differ$/m

/** True when a diff body is the standard git marker for a binary file, rather than an empty/textual diff. */
export function isBinaryDiffMarker(diff: string): boolean {
  return BINARY_DIFF_MARKER.test(diff)
}

export interface CollapsedCheckInput {
  diff: string
  deletedFile: boolean
}

/**
 * GitLab reports a file as changed but sends an EMPTY diff body when the
 * file's diff exceeds its configured limits — this is not an error response,
 * it looks identical on the wire to "nothing changed". Distinguishing the two
 * matters: a large MR that hits this on every large file must not be reported
 * as having no changes.
 *
 * Empty diff + not a deletion + not the binary-file marker = collapsed.
 * `deletedFile` is excluded because a deleted file that was already empty (0
 * bytes) legitimately produces an empty diff — that is a real absence of
 * content, not a truncation. `isBinaryDiffMarker` is checked for the same
 * reason even though it is currently redundant with the emptiness check
 * (GitLab represents a binary change with the non-empty "Binary files ...
 * differ" marker rather than an empty body) — kept as an explicit, named
 * condition rather than relying on that being true forever.
 */
export function isCollapsedDiff(file: CollapsedCheckInput): boolean {
  if (file.diff !== '') return false
  if (file.deletedFile) return false
  if (isBinaryDiffMarker(file.diff)) return false
  return true
}

// --- inline position mapping --------------------------------------------------

export interface DiffPosition {
  oldLine: number | null
  newLine: number | null
}

export type PositionableFinding = Pick<Finding, 'line' | 'lineType'>
export type PositionableFile = Pick<MergeRequestDiffFile, 'diff'>

/**
 * Maps a finding onto GitLab's inline-comment position contract:
 *
 *   added line   -> { newLine }              (old_line omitted on the wire)
 *   removed line -> { oldLine }              (new_line omitted on the wire)
 *   context line -> { oldLine AND newLine }  (both required — the case most
 *                                              implementations get wrong)
 *
 * Returns null when the finding's line does not fall inside any hunk of the
 * file's diff (including when `finding.line` is null), which the publisher
 * treats as "cannot be placed inline" and falls back to the summary note
 * rather than guessing at a position.
 *
 * `finding.line` is read as the NEW file's line number for `added` and
 * `context` findings (the file as the agent actually saw it, from `files/` at
 * head_sha) and as the OLD file's line number for `removed` findings, since a
 * removed line has no line number in the new file at all.
 */
export function positionFor(finding: PositionableFinding, file: PositionableFile): DiffPosition | null {
  if (finding.line === null) return null

  const hunks = parseHunks(file.diff)

  // `removed` is its own world, and the separation is the whole safety
  // property: a removed line exists ONLY in the pre-image, so the number names
  // an OLD-file line and the comment belongs on the left side of the diff.
  // Nothing below may reach it, and it may not reach anything below — resolving
  // a removed finding by new-file numbering is precisely how a comment lands on
  // the wrong SIDE, which is the failure this whole phase exists to prevent.
  if (finding.lineType === 'removed') {
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'removed' && line.oldLine === finding.line) {
          return { oldLine: line.oldLine, newLine: null }
        }
      }
    }
    return null
  }

  // `added` and `context` both name a line of the NEW file, so the number
  // identifies one physical line and the DIFF says which kind it is. Trusting
  // the model's label here bought nothing and cost everything: a review of five
  // Python files placed none of its seven findings, because a one-line change
  // reads to a model as "the line at 6 now says X" — `context` — while the diff
  // calls it `added`. Both descriptions point at the same line; only one
  // matched, so every finding fell back to the summary note.
  //
  // This is NOT the cross-type fallback the brief forbids. That prohibition is
  // about the old/new boundary, which is a question about which SIDE a comment
  // lands on, and it is still absolute above. Added-versus-context is not a side
  // question at all: both are the new file, the line number is unambiguous, and
  // the answer is read off the diff rather than guessed. What changes is only
  // that a mislabelled finding gets the position its line actually has, instead
  // of no position at all.
  // The leniency is ONE-DIRECTIONAL, and the asymmetry is the whole of what
  // makes it safe. The two mismatches are not the same kind of mistake:
  //
  //   claim `context`, line is `added`   -> ACCEPT.
  //       "Context" is ambiguous. A model describing a one-line change says
  //       "line 6 now reads X", which is a true statement about an added line,
  //       and labels it context. The label carries no information the diff
  //       does not already have, so the diff wins.
  //
  //   claim `added`, line is `context`   -> REFUSE.
  //       "Added" is a specific claim: this line is part of the diff's
  //       additions. When the diff says it is not, the model is wrong about
  //       something — and the likeliest thing it is wrong about is the line
  //       NUMBER. Accepting this put a comment about JSONLinesDataSource on an
  //       untouched line inside CSVDataSource, on a real merge request, which
  //       is the exact failure design §1 calls the worst in the plan.
  //
  // So the type match was quietly doing a SECOND job all along: corroborating
  // the line number. Dropping it in both directions removed a real check to
  // fix an unrelated one. Kept where it corroborates, dropped where it only
  // second-guesses a description of the same line.
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      // A removed line carries newLine === null and can never match a number.
      if (line.newLine !== finding.line) continue
      if (line.type === 'added') return { oldLine: null, newLine: line.newLine }
      // Context line: only a `context` claim corroborates it.
      if (finding.lineType === 'context') return { oldLine: line.oldLine, newLine: line.newLine }
      return null
    }
  }
  return null
}
