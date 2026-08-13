import { describe, it, expect } from 'vitest'
import {
  parseHunks,
  isCollapsedDiff,
  isBinaryDiffMarker,
  positionFor,
} from '../../src/review/diff.js'

describe('parseHunks', () => {
  it('parses a single hunk with added, removed and context lines', () => {
    const diff = [
      '@@ -10,4 +10,5 @@',
      ' unchanged one',
      '-old line',
      '+new line',
      '+another new line',
      ' unchanged two',
      '',
    ].join('\n')

    const hunks = parseHunks(diff)
    expect(hunks).toHaveLength(1)
    const hunk = hunks[0]!
    expect(hunk).toMatchObject({ oldStart: 10, oldLines: 4, newStart: 10, newLines: 5 })
    expect(hunk.lines.map((l) => [l.type, l.oldLine, l.newLine, l.text])).toEqual([
      ['context', 10, 10, 'unchanged one'],
      ['removed', 11, null, 'old line'],
      ['added', null, 11, 'new line'],
      ['added', null, 12, 'another new line'],
      ['context', 12, 13, 'unchanged two'],
    ])
  })

  it('parses multiple hunks in one diff, each with its own counters', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+c',
      '@@ -50,1 +50,2 @@',
      ' x',
      '+y',
      '',
    ].join('\n')

    const hunks = parseHunks(diff)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, null, 2])
    expect(hunks[1]!.oldStart).toBe(50)
    expect(hunks[1]!.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ['context', 50, 50],
      ['added', null, 51],
    ])
  })

  it('defaults the hunk line count to 1 when the header omits it', () => {
    const diff = '@@ -5 +5 @@\n-only line\n+replacement\n'
    const hunks = parseHunks(diff)
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 })
  })

  it('tolerates a diff --git / index / --- / +++ preamble before the first hunk', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      'index abc123..def456 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')
    const hunks = parseHunks(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines).toHaveLength(2)
  })

  it('preserves a genuinely blank context line in the middle of a hunk', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' first', '', ' third', ''].join('\n')
    const hunks = parseHunks(diff)
    const blank = hunks[0]!.lines[1]!
    expect(blank).toMatchObject({ type: 'context', text: '' })
  })

  it('skips a "no newline at end of file" marker without incrementing counters', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new', ''].join('\n')
    const hunks = parseHunks(diff)
    expect(hunks[0]!.lines.map((l) => l.type)).toEqual(['removed', 'added'])
  })

  it('returns no hunks for an empty diff', () => {
    expect(parseHunks('')).toEqual([])
  })

  it('ignores content before any @@ header when there is no hunk at all', () => {
    expect(parseHunks('Binary files a/x.png and b/x.png differ')).toEqual([])
  })
})

describe('isBinaryDiffMarker', () => {
  it('recognizes the standard git binary-file marker', () => {
    expect(isBinaryDiffMarker('Binary files a/x.png and b/x.png differ')).toBe(true)
  })

  it('does not mistake ordinary diff text for the marker', () => {
    expect(isBinaryDiffMarker('@@ -1,1 +1,1 @@\n-old\n+new\n')).toBe(false)
    expect(isBinaryDiffMarker('')).toBe(false)
  })
})

describe('isCollapsedDiff — the load-bearing empty-vs-collapsed distinction', () => {
  it('treats an empty diff on a live, non-deleted file as collapsed', () => {
    // This is the case that matters: a large MR where GitLab elided the diff
    // body for exceeding its size limit, not an error, just an empty string.
    expect(isCollapsedDiff({ diff: '', deletedFile: false })).toBe(true)
  })

  it('does NOT treat an empty diff on a deleted file as collapsed — a genuinely empty change', () => {
    // An already-empty (0-byte) file being deleted produces an empty diff
    // for a real reason, not a truncation.
    expect(isCollapsedDiff({ diff: '', deletedFile: true })).toBe(false)
  })

  it('does not treat a non-empty diff as collapsed, regardless of content', () => {
    expect(isCollapsedDiff({ diff: '@@ -1,1 +1,1 @@\n-a\n+b\n', deletedFile: false })).toBe(false)
  })

  it('does not treat the binary-file marker as collapsed', () => {
    expect(isCollapsedDiff({ diff: 'Binary files a/x.png and b/x.png differ', deletedFile: false })).toBe(false)
  })
})

describe('positionFor', () => {
  const diff = [
    '@@ -10,4 +10,5 @@',
    ' unchanged one',
    '-old line',
    '+new line',
    '+another new line',
    ' unchanged two',
    '',
  ].join('\n')
  const file = { diff }

  it('maps an added line to { newLine } only — no oldLine', () => {
    const pos = positionFor({ line: 11, lineType: 'added' }, file)
    expect(pos).toEqual({ oldLine: null, newLine: 11 })
  })

  it('maps a removed line to { oldLine } only — no newLine', () => {
    const pos = positionFor({ line: 11, lineType: 'removed' }, file)
    expect(pos).toEqual({ oldLine: 11, newLine: null })
  })

  it('maps a context line to BOTH oldLine and newLine — the case implementations get wrong', () => {
    // "unchanged two" is old line 12 / new line 13 after the hunk's one net
    // insertion. A saboteur returning only { newLine: 13 } here (dropping
    // oldLine) must fail this assertion.
    const pos = positionFor({ line: 13, lineType: 'context' }, file)
    expect(pos).toEqual({ oldLine: 12, newLine: 13 })
    expect(pos!.oldLine).not.toBeNull()
    expect(pos!.newLine).not.toBeNull()
  })

  it('returns null when the line falls outside every hunk', () => {
    expect(positionFor({ line: 9999, lineType: 'added' }, file)).toBeNull()
  })

  it('returns null when finding.line is null', () => {
    expect(positionFor({ line: null, lineType: 'context' }, file)).toBeNull()
  })

  it('does not match a line number against the wrong lineType', () => {
    // Line 11 exists as a removed old-line and as an added new-line in this
    // hunk; asking for it as 'context' must not accidentally match either.
    expect(positionFor({ line: 11, lineType: 'context' }, file)).toBeNull()
  })

  it('finds a line across multiple hunks in the same file', () => {
    const multi = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+c',
      '@@ -50,1 +50,2 @@',
      ' x',
      '+y',
      '',
    ].join('\n')
    expect(positionFor({ line: 51, lineType: 'added' }, { diff: multi })).toEqual({ oldLine: null, newLine: 51 })
  })
})
