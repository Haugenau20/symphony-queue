import { describe, it, expect } from 'vitest'
import {
  placeFinding,
  threadFingerprint,
  assignOrdinals,
  inlineThreadMarker,
  parseInlineThreadMarker,
} from '../../src/review/inline.js'
import type { Finding, MergeRequestDiffFile, ReviewJob } from '../../src/review/types.js'

// --- fixtures ------------------------------------------------------------------

/**
 * Single-hunk fixture, identical in shape to diff.test.ts's positionFor
 * fixture so the hand-counted line numbers below are cross-checkable against
 * an already-proven source of truth.
 *
 *   @@ -10,4 +10,5 @@
 *    unchanged one        context   old=10 new=10
 *   -old line             removed   old=11
 *   +new line             added              new=11
 *   +another new line     added              new=12
 *    unchanged two        context   old=12 new=13
 */
const SINGLE_HUNK_DIFF = [
  '@@ -10,4 +10,5 @@',
  ' unchanged one',
  '-old line',
  '+new line',
  '+another new line',
  ' unchanged two',
  '',
].join('\n')

/**
 * Three-hunk fixture. Hand-counted line numbers:
 *
 *   Hunk 1  @@ -1,3 +1,3 @@
 *      line1              context   old=1  new=1
 *     -old2               removed   old=2
 *     +new2               added              new=2
 *      line3              context   old=3  new=3
 *
 *   Hunk 2  @@ -20,3 +20,3 @@
 *      ctx20              context   old=20 new=20
 *     -old21              removed   old=21
 *     +new21              added              new=21
 *      ctx23              context   old=22 new=22
 *
 *   Hunk 3  @@ -50,1 +50,2 @@
 *      x                  context   old=50 new=50
 *     +y                  added              new=51
 *
 * New line 51 exists ONLY in hunk 3 — no other hunk's numbering reaches it —
 * so a finding resolving to { newLine: 51 } could only have come from the
 * third hunk.
 */
const MULTI_HUNK_DIFF = [
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-old2',
  '+new2',
  ' line3',
  '@@ -20,3 +20,3 @@',
  ' ctx20',
  '-old21',
  '+new21',
  ' ctx23',
  '@@ -50,1 +50,2 @@',
  ' x',
  '+y',
  '',
].join('\n')

function makeFile(overrides: Partial<MergeRequestDiffFile> = {}): MergeRequestDiffFile {
  return {
    oldPath: 'src/foo.ts',
    newPath: 'src/foo.ts',
    diff: SINGLE_HUNK_DIFF,
    newFile: false,
    renamedFile: false,
    deletedFile: false,
    generatedFile: false,
    collapsed: false,
    ...overrides,
  }
}

function makeJob(overrides: Partial<Pick<ReviewJob, 'baseSha' | 'startSha'>> & { headSha?: string } = {}): ReviewJob {
  const { headSha, ...rest } = overrides
  return {
    key: { projectId: 'group/proj', mrIid: 1, headSha: headSha ?? 'head123' },
    baseSha: 'base123',
    startSha: 'start123',
    title: 'Some MR',
    webUrl: null,
    state: 'running',
    attempts: 0,
    nextRetryAt: null,
    discoveredAt: new Date('2026-08-18T00:00:00Z'),
    publishedNoteId: null,
    skipReason: null,
    ...rest,
  }
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'concern',
    file: 'src/foo.ts',
    line: 11,
    lineType: 'added',
    title: 'Some finding',
    detail: 'Some detail',
    suggestion: null,
    ...overrides,
  }
}

// --- placeFinding: happy paths --------------------------------------------------

describe('placeFinding — happy paths', () => {
  it('places an added-line finding: newLine set, oldLine null, matching the hand-counted diff', () => {
    const finding = makeFinding({ line: 11, lineType: 'added' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position.newLine).toBe(11)
    expect(result.position.oldLine).toBeNull()
  })

  it('places a removed-line finding: oldLine set, newLine null, finding.line read as the OLD numbering', () => {
    // "old line" is old-file line 11 (there is no new-file line 11 for the
    // removed line at all).
    const finding = makeFinding({ line: 11, lineType: 'removed' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position.oldLine).toBe(11)
    expect(result.position.newLine).toBeNull()
  })

  it('places a context-line finding with BOTH line numbers, and they differ from each other', () => {
    // "unchanged two" is old line 12 / new line 13 after the hunk's net
    // insertion — a fixture where they coincide could not catch a bug.
    const finding = makeFinding({ line: 13, lineType: 'context' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position.oldLine).toBe(12)
    expect(result.position.newLine).toBe(13)
    expect(result.position.oldLine).not.toBe(result.position.newLine)
  })

  it('carries the full position contract: three SHAs from the job, both paths from the file, positionType text', () => {
    const finding = makeFinding({ file: 'b.ts', line: 11, lineType: 'added' })
    const job = makeJob({ baseSha: 'BBB', startSha: 'SSS', headSha: 'HHH' })
    const file = makeFile({ oldPath: 'a.ts', newPath: 'b.ts' })
    const result = placeFinding(finding, [file], job)
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position).toEqual({
      baseSha: 'BBB',
      startSha: 'SSS',
      headSha: 'HHH',
      oldPath: 'a.ts',
      newPath: 'b.ts',
      positionType: 'text',
      oldLine: null,
      newLine: 11,
    })
  })

  it('resolves a renamed file (oldPath != newPath) by newPath, and carries BOTH paths from the file', () => {
    const file = makeFile({ oldPath: 'old/name.ts', newPath: 'new/name.ts', renamedFile: true })
    const finding = makeFinding({ file: 'new/name.ts', line: 11, lineType: 'added' })
    const result = placeFinding(finding, [file], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position.oldPath).toBe('old/name.ts')
    expect(result.position.newPath).toBe('new/name.ts')
  })

  it('uses the correct hunk-specific line numbers for a finding in the third of several hunks', () => {
    const file = makeFile({ diff: MULTI_HUNK_DIFF })
    const finding = makeFinding({ line: 51, lineType: 'added' })
    const result = placeFinding(finding, [file], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position.newLine).toBe(51)
    expect(result.position.oldLine).toBeNull()
  })
})

// --- placeFinding: refusals ------------------------------------------------------

describe('placeFinding — refusals', () => {
  it('refuses no_line when finding.line is null', () => {
    const finding = makeFinding({ line: null })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result).toEqual({ kind: 'unplaceable', reason: 'no_line' })
  })

  it('refuses file_not_in_diff when no file in the set matches finding.file', () => {
    const finding = makeFinding({ file: 'does/not/exist.ts' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result).toEqual({ kind: 'unplaceable', reason: 'file_not_in_diff' })
  })

  it('refuses ambiguous_file, and produces no position at all, when finding.file matches one file\'s newPath and another file\'s oldPath', () => {
    const fileX = makeFile({ oldPath: 'x-old.ts', newPath: 'shared.ts' })
    const fileY = makeFile({ oldPath: 'shared.ts', newPath: 'y-new.ts' })
    const finding = makeFinding({ file: 'shared.ts' })
    const result = placeFinding(finding, [fileX, fileY], makeJob())
    expect(result).toEqual({ kind: 'unplaceable', reason: 'ambiguous_file' })
  })

  it('REFUSES an "added" claim on a line that is actually context — the number is not corroborated', () => {
    // New line 13 ("unchanged two") is a context line. "Added" is a specific
    // claim -- this line is part of the diff's additions -- and the diff says
    // it is not, so the model is wrong about something. The likeliest thing is
    // the line NUMBER.
    //
    // This is not hypothetical. Accepting this placed a comment describing
    // JSONLinesDataSource onto an untouched line inside CSVDataSource on a
    // real merge request: the model cited a line number belonging to different
    // code, and the type mismatch was the only thing that knew. The lineType
    // match corroborates the number; that is a second job it does beyond
    // choosing a position shape, and it is why the leniency in the mirror test
    // below runs in ONE direction only.
    const finding = makeFinding({ line: 13, lineType: 'added' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result).toEqual({ kind: 'unplaceable', reason: 'outside_hunk' })
  })

  it('places a "context" claim on a genuinely added line, with the ADDED position (the mirror case)', () => {
    // New line 11 ("new line") is an added line. This is the exact shape that
    // placed nothing on a real merge request: a one-line change reads to the
    // model as "line 11 now says X" and gets labelled context, while the diff
    // calls it added. An added line has no old-file counterpart, so oldLine
    // must be absent here.
    const finding = makeFinding({ line: 11, lineType: 'context' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result.kind).toBe('placed')
    if (result.kind !== 'placed') throw new Error('unreachable')
    expect(result.position).toMatchObject({ oldLine: null, newLine: 11 })
  })

  it('a REMOVED claim is still never resolved by new-file numbering', () => {
    // The line that must not move. `removed` names an OLD-file line, and
    // crossing that boundary puts the comment on the wrong SIDE of the diff —
    // the failure this phase exists to prevent, and the reason the leniency
    // above is confined to added-versus-context.
    const finding = makeFinding({ line: 12, lineType: 'removed' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    // New line 12 is "another new line" (added). As a removed claim it must
    // NOT resolve to it; either nothing, or a genuine old-side position.
    if (result.kind === 'placed') {
      expect(result.position.newLine).toBeNull()
    } else {
      expect(result.reason).toBe('outside_hunk')
    }
  })

  it('refuses outside_hunk when finding.line is beyond the end of every hunk', () => {
    const finding = makeFinding({ line: 9999, lineType: 'added' })
    const result = placeFinding(finding, [makeFile()], makeJob())
    expect(result).toEqual({ kind: 'unplaceable', reason: 'outside_hunk' })
  })

  it('refuses no_diff_refs when baseSha is empty', () => {
    const result = placeFinding(makeFinding(), [makeFile()], makeJob({ baseSha: '' }))
    expect(result).toEqual({ kind: 'unplaceable', reason: 'no_diff_refs' })
  })

  it('refuses no_diff_refs when startSha is empty', () => {
    const result = placeFinding(makeFinding(), [makeFile()], makeJob({ startSha: '' }))
    expect(result).toEqual({ kind: 'unplaceable', reason: 'no_diff_refs' })
  })

  it('refuses no_diff_refs when headSha is empty', () => {
    const result = placeFinding(makeFinding(), [makeFile()], makeJob({ headSha: '' }))
    expect(result).toEqual({ kind: 'unplaceable', reason: 'no_diff_refs' })
  })

  it('checks no_diff_refs before no_line — an empty SHA refuses even a summary-level finding', () => {
    const finding = makeFinding({ line: null })
    const result = placeFinding(finding, [makeFile()], makeJob({ baseSha: '' }))
    expect(result).toEqual({ kind: 'unplaceable', reason: 'no_diff_refs' })
  })
})

// --- threadFingerprint -----------------------------------------------------------

describe('threadFingerprint', () => {
  it('is stable when the line number changes', () => {
    const a = makeFinding({ line: 11 })
    const b = makeFinding({ line: 999 })
    expect(threadFingerprint(a, 0)).toBe(threadFingerprint(b, 0))
  })

  it('is stable when the detail is reworded', () => {
    const a = makeFinding({ detail: 'first wording' })
    const b = makeFinding({ detail: 'a completely different wording of the same issue' })
    expect(threadFingerprint(a, 0)).toBe(threadFingerprint(b, 0))
  })

  it('is stable across trivial title whitespace/case differences (normalization)', () => {
    const a = makeFinding({ title: 'Missing   null check' })
    const b = makeFinding({ title: '  missing null check  ' })
    expect(threadFingerprint(a, 0)).toBe(threadFingerprint(b, 0))
  })

  it('changes when the file changes', () => {
    const a = makeFinding({ file: 'a.ts' })
    const b = makeFinding({ file: 'b.ts' })
    expect(threadFingerprint(a, 0)).not.toBe(threadFingerprint(b, 0))
  })

  it('changes when the lineType changes', () => {
    const a = makeFinding({ lineType: 'added' })
    const b = makeFinding({ lineType: 'context' })
    expect(threadFingerprint(a, 0)).not.toBe(threadFingerprint(b, 0))
  })

  it('changes when the title changes', () => {
    const a = makeFinding({ title: 'Missing null check' })
    const b = makeFinding({ title: 'Off-by-one error' })
    expect(threadFingerprint(a, 0)).not.toBe(threadFingerprint(b, 0))
  })

  it('changes when the ordinal changes', () => {
    const a = makeFinding()
    expect(threadFingerprint(a, 0)).not.toBe(threadFingerprint(a, 1))
  })
})

describe('assignOrdinals', () => {
  it('gives two findings sharing (file, lineType, title) ordinals 0 and 1, producing different fingerprints', () => {
    const findings = [
      makeFinding({ title: 'Missing null check', detail: 'first occurrence' }),
      makeFinding({ title: 'Missing null check', detail: 'second occurrence' }),
    ]
    const ordinals = assignOrdinals(findings)
    expect(ordinals).toEqual([0, 1])
    const fpA = threadFingerprint(findings[0]!, ordinals[0]!)
    const fpB = threadFingerprint(findings[1]!, ordinals[1]!)
    expect(fpA).not.toBe(fpB)
  })

  it('assigns 0 to unrelated findings independently — groups do not interfere', () => {
    const findings = [
      makeFinding({ file: 'a.ts', title: 'Issue one' }),
      makeFinding({ file: 'b.ts', title: 'Issue two' }),
      makeFinding({ file: 'a.ts', title: 'Issue one' }), // second in its group
    ]
    expect(assignOrdinals(findings)).toEqual([0, 0, 1])
  })

  it('is deterministic and parallel to the input array', () => {
    const findings = [makeFinding(), makeFinding(), makeFinding()]
    const ordinals = assignOrdinals(findings)
    expect(ordinals).toHaveLength(3)
    expect(ordinals).toEqual([0, 1, 2])
  })
})

// --- marker ------------------------------------------------------------------------

describe('inlineThreadMarker / parseInlineThreadMarker', () => {
  it('round-trips what inlineThreadMarker wrote', () => {
    const marker = inlineThreadMarker('abc123', 'deadbeef01234567')
    const parsed = parseInlineThreadMarker(`Some note body.\n\n${marker}\n`)
    expect(parsed).toEqual({ headSha: 'abc123', fingerprint: 'deadbeef01234567' })
  })

  it('returns null for a body with no marker at all', () => {
    expect(parseInlineThreadMarker('Just a regular comment, nothing hidden here.')).toBeNull()
  })

  it('returns null, rather than throwing, for a malformed marker', () => {
    expect(() => parseInlineThreadMarker('<!-- symphony-review-thread:garbage -->')).not.toThrow()
    expect(parseInlineThreadMarker('<!-- symphony-review-thread:garbage -->')).toBeNull()
  })

  it('reads the FIRST marker and ignores anything after it', () => {
    const first = inlineThreadMarker('sha-one', 'fp-one-1234567890')
    const second = inlineThreadMarker('sha-two', 'fp-two-1234567890')
    const parsed = parseInlineThreadMarker(`${first}\nmore text\n${second}`)
    expect(parsed).toEqual({ headSha: 'sha-one', fingerprint: 'fp-one-1234567890' })
  })
})
