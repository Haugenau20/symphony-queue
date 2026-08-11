import { describe, it, expect } from 'vitest'
import { parseFindingsDocument, safeParseFindingsDocument } from '../../src/review/findings.js'

function validDocument() {
  return {
    summary: 'Three issues, one blocking.',
    findings: [
      {
        severity: 'blocking',
        file: 'src/tracker/gitlab.ts',
        line: 342,
        lineType: 'added',
        title: 'Token may be logged on retry',
        detail: 'The retry path logs the request init object, which includes the header.',
        suggestion: 'Log only the method and path.',
      },
      {
        severity: 'nit',
        file: 'src/review/diff.ts',
        line: null,
        lineType: 'context',
        title: 'Consider a comment',
        detail: 'General note not tied to a line.',
        suggestion: null,
      },
    ],
  }
}

describe('parseFindingsDocument — accepts valid input', () => {
  it('round-trips a well-formed document unchanged', () => {
    const doc = validDocument()
    const parsed = parseFindingsDocument(doc)
    expect(parsed).toEqual(doc)
  })

  it('accepts an empty findings array with just a summary', () => {
    const doc = { summary: 'No issues found.', findings: [] }
    expect(parseFindingsDocument(doc)).toEqual(doc)
  })

  it('accepts every documented severity and lineType', () => {
    for (const severity of ['blocking', 'concern', 'nit'] as const) {
      for (const lineType of ['added', 'removed', 'context'] as const) {
        const doc = {
          summary: 's',
          findings: [{ severity, file: 'f.ts', line: 1, lineType, title: 't', detail: 'd', suggestion: null }],
        }
        expect(() => parseFindingsDocument(doc)).not.toThrow()
      }
    }
  })
})

describe('parseFindingsDocument — rejects malformed input', () => {
  it('rejects a document missing the summary field', () => {
    const doc = { findings: [] } as unknown
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects a document missing the findings field', () => {
    const doc = { summary: 'ok' } as unknown
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects a finding missing a required field', () => {
    const doc = {
      summary: 's',
      findings: [{ severity: 'nit', file: 'f.ts', lineType: 'added', title: 't', detail: 'd', suggestion: null }],
    }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects the wrong type for a field (line as a string)', () => {
    const doc = {
      summary: 's',
      findings: [{ severity: 'nit', file: 'f.ts', line: '342', lineType: 'added', title: 't', detail: 'd', suggestion: null }],
    }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects the wrong type for a field (findings as an object, not an array)', () => {
    const doc = { summary: 's', findings: {} }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('does NOT coerce a numeric string into a number', () => {
    const doc = {
      summary: 's',
      findings: [{ severity: 'nit', file: 'f.ts', line: '5', lineType: 'context', title: 't', detail: 'd', suggestion: null }],
    }
    const result = safeParseFindingsDocument(doc)
    expect(result.success).toBe(false)
  })

  it('rejects an invalid enum value for severity', () => {
    const doc = {
      summary: 's',
      findings: [{ severity: 'critical', file: 'f.ts', line: 1, lineType: 'added', title: 't', detail: 'd', suggestion: null }],
    }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects an invalid enum value for lineType', () => {
    const doc = {
      summary: 's',
      findings: [{ severity: 'nit', file: 'f.ts', line: 1, lineType: 'modified', title: 't', detail: 'd', suggestion: null }],
    }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })

  it('rejects a non-object document entirely', () => {
    expect(() => parseFindingsDocument('not a document')).toThrow()
    expect(() => parseFindingsDocument(null)).toThrow()
    expect(() => parseFindingsDocument([])).toThrow()
  })
})

describe('unknown keys — RULING 1: rejected, not dropped', () => {
  it('rejects an unknown top-level key on the document', () => {
    const doc = { ...validDocument(), extra_field: 'sneaked in' }
    const result = safeParseFindingsDocument(doc)
    expect(result.success).toBe(false)
  })

  it('rejects an unknown key on an individual finding', () => {
    const doc = validDocument()
    ;(doc.findings[0] as unknown as Record<string, unknown>).confidence = 0.9
    const result = safeParseFindingsDocument(doc)
    expect(result.success).toBe(false)
  })

  it('a document with an unknown key never silently survives as a stripped-down valid one', () => {
    // The wrong behaviour (file_queue's posture, deliberately NOT used here)
    // would parse this successfully with `sneaky` dropped. Assert the whole
    // parse fails instead.
    const doc = { summary: 's', findings: [], sneaky: 'agent-controlled' }
    expect(() => parseFindingsDocument(doc)).toThrow()
  })
})

describe('safeParseFindingsDocument', () => {
  it('returns a readable error path without throwing', () => {
    const result = safeParseFindingsDocument({ summary: 's' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('findings')
    }
  })

  it('never echoes the offending finding content back in the error string', () => {
    const secretLookingDetail = 'token=glpat-should-not-appear-in-error'
    const doc = {
      summary: 's',
      findings: [{ severity: 'nit', file: 'f.ts', line: 'not-a-number', lineType: 'added', title: 't', detail: secretLookingDetail, suggestion: null }],
    }
    const result = safeParseFindingsDocument(doc)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).not.toContain('glpat-should-not-appear-in-error')
    }
  })
})
