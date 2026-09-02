/**
 * SLICE C: inline discussion publishing — placement, escaping, dedup across
 * re-reviews, cleanup of prior-revision threads, and the fallback into
 * the summary note.
 *
 * Kept separate from publisher.test.ts (which SLICE C must not touch — its
 * security tests are load-bearing and must pass UNCHANGED) so the two files'
 * fake clients can evolve independently.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ReviewPublisher,
  renderInlineDiscussionBody,
  renderReviewNote,
  reviewNoteMarker,
  type ReviewPublishClient,
} from '../../src/review/publisher.js'
import { assignOrdinals, inlineThreadMarker, parseInlineThreadMarker, threadFingerprint } from '../../src/review/inline.js'
import { getLogger } from '../../src/log.js'
import type {
  Discussion,
  DiscussionPosition,
  Finding,
  FindingsDocument,
  InlinePublishOutcome,
  MergeRequestDiffFile,
  MergeRequestSummary,
  ReviewJob,
  ReviewJobKey,
} from '../../src/review/types.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function key(overrides: Partial<ReviewJobKey> = {}): ReviewJobKey {
  return { projectId: 'my-org/service-a', mrIid: 500, headSha: 'head-sha-1', ...overrides }
}

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    key: key(),
    baseSha: 'base-sha-1',
    startSha: 'start-sha-1',
    title: 'Add a feature',
    webUrl: null,
    state: 'publishing',
    attempts: 0,
    nextRetryAt: null,
    discoveredAt: new Date('2026-08-10T00:00:00Z'),
    publishedNoteId: null,
    skipReason: null,
    ...overrides,
  }
}

function summary(overrides: Partial<MergeRequestSummary> = {}): MergeRequestSummary {
  return {
    projectId: 'my-org/service-a',
    mrIid: 500,
    headSha: 'head-sha-1',
    baseSha: 'base-sha-1',
    startSha: 'start-sha-1',
    title: 'Add a feature',
    description: null,
    draft: false,
    isFork: false,
    state: 'opened',
    webUrl: null,
    updatedAt: new Date('2026-08-10T00:00:00Z'),
    ...overrides,
  }
}

/**
 * Same shape as inline.test.ts's fixture, deliberately: hand-counted line
 * numbers already proven correct there.
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

function diffFile(overrides: Partial<MergeRequestDiffFile> = {}): MergeRequestDiffFile {
  return {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    diff: SINGLE_HUNK_DIFF,
    newFile: false,
    renamedFile: false,
    deletedFile: false,
    generatedFile: false,
    collapsed: false,
    ...overrides,
  }
}

// One list, used both to validate a finding's file and to position it.
const diffFiles = [diffFile()]

function placeableFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'blocking',
    file: 'src/a.ts',
    line: 11, // "+new line" -> newLine 11
    lineType: 'added',
    title: 'Off-by-one in the retry loop',
    detail: 'The loop condition never terminates when count is negative.',
    suggestion: 'Use a bounded loop instead.',
    ...overrides,
  }
}

function unplaceableFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'nit',
    file: 'src/a.ts',
    line: null,
    lineType: 'context',
    title: 'Inconsistent naming',
    detail: 'wsPath vs workspacePath for the same concept.',
    suggestion: null,
    ...overrides,
  }
}

interface FakeNote {
  id: string
  body: string
  authorId: string | null
}

interface FakeDiscussion {
  id: string
  resolvable: boolean
  resolved: boolean
  notes: FakeNote[]
}

interface FakeCalls {
  getMergeRequest: number
  listNotes: number
  createNote: string[]
  listDiscussions: number
  createDiscussion: Array<{ body: string; position: DiscussionPosition }>
  resolveDiscussion: Array<{ discussionId: string }>
  callOrder: string[]
}

/**
 * A fake implementing the FULL {@link ReviewPublishClient} surface — the read
 * methods AND all three discussion operations — so `inlineComments: true`
 * always finds a client it can use.
 */
function fakeInlineClient(
  opts: {
    summaries?: (MergeRequestSummary | null)[]
    notes?: FakeNote[]
    discussions?: FakeDiscussion[]
    selfUserId?: string | null
    /** Return true to make this create call throw instead of succeeding. */
    createShouldThrow?: (body: string, position: DiscussionPosition) => boolean
    resolveShouldThrow?: (discussionId: string) => boolean
    resolveResult?: (discussionId: string) => boolean
    /** Injected into thrown errors, to prove it never reaches a log line. */
    hostilePayload?: string
  } = {},
): ReviewPublishClient & { calls: FakeCalls; sawConcurrentCreates: boolean } {
  const summaries = opts.summaries ?? [summary()]
  let summaryIdx = 0
  const notes: FakeNote[] = opts.notes ? [...opts.notes] : []
  const discussions: FakeDiscussion[] = opts.discussions
    ? opts.discussions.map((d) => ({ ...d, notes: d.notes.map((n) => ({ ...n })) }))
    : []
  const selfUserId = opts.selfUserId === undefined ? 'self' : opts.selfUserId
  let noteCounter = 0
  let discussionCounter = 0
  let inFlightCreates = 0
  const state = { sawConcurrentCreates: false }

  const calls: FakeCalls = {
    getMergeRequest: 0,
    listNotes: 0,
    createNote: [],
    listDiscussions: 0,
    createDiscussion: [],
    resolveDiscussion: [],
    callOrder: [],
  }

  return {
    calls,
    get sawConcurrentCreates() {
      return state.sawConcurrentCreates
    },
    async getMergeRequest() {
      calls.getMergeRequest++
      const idx = Math.min(summaryIdx, summaries.length - 1)
      summaryIdx++
      return summaries[idx] ?? null
    },
    async listNotes() {
      calls.listNotes++
      return notes.map((n) => ({ ...n }))
    },
    async getCurrentUserId() {
      return selfUserId
    },
    async createNote(_p: string, _i: number, body: string) {
      const id = `note-${++noteCounter}`
      notes.push({ id, body, authorId: selfUserId })
      calls.createNote.push(body)
      calls.callOrder.push('createNote')
      return id
    },
    async listDiscussions(): Promise<Discussion[]> {
      calls.listDiscussions++
      return discussions.map((d) => ({
        id: d.id,
        resolvable: d.resolvable,
        resolved: d.resolved,
        notes: d.notes.map((n) => ({ id: n.id, body: n.body, authorId: n.authorId, position: null })),
      }))
    },
    async createDiscussion(_p: string, _i: number, body: string, position: DiscussionPosition) {
      inFlightCreates++
      if (inFlightCreates > 1) state.sawConcurrentCreates = true
      calls.createDiscussion.push({ body, position })
      calls.callOrder.push('createDiscussion')
      // A tiny delay so a Promise.all implementation (which would start every
      // create before any of them finishes) is distinguishable from a
      // sequential one.
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlightCreates--
      if (opts.createShouldThrow?.(body, position)) {
        throw Object.assign(new Error(`create failed${opts.hostilePayload ? `: ${opts.hostilePayload}` : ''}`), {
          status: 500,
        })
      }
      const id = `disc-${++discussionCounter}`
      discussions.push({ id, resolvable: true, resolved: false, notes: [{ id: `${id}-n1`, body, authorId: selfUserId }] })
      return id
    },
    async resolveDiscussion(_p: string, _i: number, discussionId: string) {
      calls.resolveDiscussion.push({ discussionId })
      calls.callOrder.push('resolveDiscussion')
      if (opts.resolveShouldThrow?.(discussionId)) {
        throw Object.assign(new Error(`resolve failed${opts.hostilePayload ? `: ${opts.hostilePayload}` : ''}`), {
          status: 500,
        })
      }
      return opts.resolveResult ? opts.resolveResult(discussionId) : true
    },
  }
}

function threeFindingsDoc(): FindingsDocument {
  return { summary: 'One placeable finding and one that is not.', findings: [placeableFinding(), unplaceableFinding()] }
}

function publisher(client: ReviewPublishClient, inlineComments = false): ReviewPublisher {
  return new ReviewPublisher({ mrClient: client, inlineComments })
}

function asPublished(result: {
  status: string
}): { status: 'published'; noteId: string; body: string; inline: InlinePublishOutcome } {
  if (result.status !== 'published') throw new Error(`expected published, got ${result.status}`)
  const r = result as { status: 'published'; noteId: string; body: string; inline?: InlinePublishOutcome }
  if (!r.inline) throw new Error('expected inline outcome to be populated on a published result')
  return { status: 'published', noteId: r.noteId, body: r.body, inline: r.inline }
}

// ---------------------------------------------------------------------------

describe('inline comments OFF — byte-identical to today', () => {
  it('makes ZERO discussion API calls, and the note is character-identical to the pre-inline fixture', async () => {
    const doc: FindingsDocument = { summary: 'A tidy little review.', findings: [placeableFinding(), unplaceableFinding()] }
    // The fixture: renderReviewNote's own 2-argument behaviour, which SLICE C
    // never changes (the 3rd `extraLine` parameter is additive and optional).
    const fixture = renderReviewNote(doc, 'head-sha-1')

    const clientDefault = fakeInlineClient()
    const resultDefault = await new ReviewPublisher({ mrClient: clientDefault }).publish({ job: job(), findings: doc, diffFiles })
    const published1 = asPublished(resultDefault)
    expect(published1.body).toBe(fixture)

    const clientExplicit = fakeInlineClient()
    const resultExplicit = await publisher(clientExplicit, false).publish({ job: job(), findings: doc, diffFiles })
    const published2 = asPublished(resultExplicit)
    expect(published2.body).toBe(fixture)

    for (const c of [clientDefault, clientExplicit]) {
      expect(c.calls.listDiscussions).toBe(0)
      expect(c.calls.createDiscussion).toHaveLength(0)
      expect(c.calls.resolveDiscussion).toHaveLength(0)
      expect(c.calls.createNote).toHaveLength(1)
    }
  })
})

describe('inline comments ON — placement', () => {
  it('a placeable finding produces one createDiscussion carrying the full position, and is absent from the note', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [placeableFinding()] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(1)
    expect(client.calls.createDiscussion[0]!.position).toEqual({
      baseSha: 'base-sha-1',
      startSha: 'start-sha-1',
      headSha: 'head-sha-1',
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      positionType: 'text',
      oldLine: null,
      newLine: 11,
    })
    expect(p.body).not.toContain('Off-by-one in the retry loop')
    expect(p.inline.placed).toBe(1)
    expect(p.inline.attempted).toBe(true)
  })

  it('an unplaceable finding produces NO createDiscussion and IS in the note, at its original severity', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [unplaceableFinding()] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(0)
    expect(p.body).toContain('### Minor')
    expect(p.body).toContain('Inconsistent naming')
    expect(p.inline.fellBack).toBe(1)
    expect(p.inline.fallbackReasons.no_line).toBe(1)
  })

  it('zero findings still posts a note', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 'nothing found', findings: [] },
      diffFiles,
    })
    const p = asPublished(result)
    expect(p.body).toContain('No findings.')
    expect(client.calls.createNote).toHaveLength(1)
    // Discussions are still listed once — supersession (step 7) needs the
    // list even when there is nothing new to place.
    expect(client.calls.listDiscussions).toBe(1)
  })

  it('every finding placed inline still posts a note', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [placeableFinding()] },
      diffFiles,
    })
    const p = asPublished(result)
    expect(client.calls.createNote).toHaveLength(1)
    // NOT "No findings." — that is the whole point. A note saying "No findings."
    // directly above "1 finding was posted as inline comment on this revision"
    // reads, at a glance, as "the reviewer found nothing", which is the one
    // meaning silence must never be able to carry here. A real review published
    // exactly that: "No findings." over "4 findings were posted as inline
    // comments".
    expect(p.body).not.toContain('No findings.')
    expect(p.body).toContain('Every finding was placed on its own line')
    expect(p.body).toContain('posted as inline comment')
  })

  it('says "No findings." only when there genuinely were none', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 'nothing to report', findings: [] },
      diffFiles,
    })
    const p = asPublished(result)
    expect(p.body).toContain('No findings.')
    expect(p.body).not.toContain('Every finding was placed')
  })

  it('an unplaceable finding is listed, so the note is not falsely empty', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [unplaceableFinding()] },
      diffFiles,
    })
    const p = asPublished(result)
    expect(p.body).not.toContain('No findings.')
    expect(p.body).not.toContain('Every finding was placed')
  })
})

describe('inline comments ON — escaping (the phase-2 bug must not recur inline)', () => {
  const hostileTitle = 'ends bold ** <script>alert(1)</script> and a ] bracket and ```fence```'

  it('renderInlineDiscussionBody escapes the same way renderReviewNote does', () => {
    const finding: Finding = { ...placeableFinding(), title: hostileTitle, detail: 'payload like <!-- swallow everything\nand a # heading' }
    const body = renderInlineDiscussionBody(finding, 'head-sha-1', 'fingerprint123')

    expect(body).not.toContain('<script>')
    expect(body).toContain('&lt;script&gt;')
    expect(body).not.toContain('<!-- swallow')
    expect(body).toContain('&lt;!--')
    expect(body).not.toMatch(/^# heading/m)
    expect(body).toMatch(/^\*\*.*\*\*$/m)
    expect(body.startsWith(inlineThreadMarker('head-sha-1', 'fingerprint123'))).toBe(true)
  })

  it('the same hostile title survives end to end through publish() as an escaped createDiscussion body', async () => {
    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [placeableFinding({ title: hostileTitle })] },
      diffFiles,
    })
    asPublished(result)
    expect(client.calls.createDiscussion).toHaveLength(1)
    const body = client.calls.createDiscussion[0]!.body
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('```fence```')
  })
})

describe('inline comments ON — dedup against our own existing threads', () => {
  it('the SAME headSha and fingerprint, authored by us, is not re-posted', async () => {
    const finding = placeableFinding()
    const fp = threadFingerprint(finding, 0)
    const marker = inlineThreadMarker('head-sha-1', fp)
    const client = fakeInlineClient({
      discussions: [{ id: 'existing-1', resolvable: true, resolved: false, notes: [{ id: 'n1', body: `${marker}\nAlready posted.`, authorId: 'self' }] }],
    })

    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [finding] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(0)
    expect(p.inline.alreadyPresent).toBe(1)
    expect(p.inline.placed).toBe(0)
  })

  it('that same thread authored by SOMEONE ELSE does not suppress posting, and a warning is logged', async () => {
    const logged: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(getLogger(), 'warn').mockImplementation(((obj: unknown) => {
      logged.push(obj as Record<string, unknown>)
      return undefined
    }) as never)

    try {
      const finding = placeableFinding()
      const fp = threadFingerprint(finding, 0)
      const marker = inlineThreadMarker('head-sha-1', fp)
      const client = fakeInlineClient({
        discussions: [{ id: 'impostor', resolvable: true, resolved: false, notes: [{ id: 'n1', body: `${marker}\nnothing to see here`, authorId: 'someone-else' }] }],
      })

      const result = await publisher(client, true).publish({
        job: job(),
        findings: { summary: 's', findings: [finding] },
        diffFiles,
        })
      const p = asPublished(result)

      expect(client.calls.createDiscussion).toHaveLength(1)
      expect(p.inline.placed).toBe(1)
      const warned = logged.find((l) => l.foreignThreadCount !== undefined)
      expect(warned).toBeDefined()
      expect(warned!.foreignThreadCount).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('a DIFFERENT headSha with the same fingerprint gets a new thread and directly resolves the old one without posting a reply', async () => {
    const finding = placeableFinding()
    const fp = threadFingerprint(finding, 0)
    const oldMarker = inlineThreadMarker('an-older-sha', fp)
    const client = fakeInlineClient({
      discussions: [{ id: 'old-thread', resolvable: true, resolved: false, notes: [{ id: 'n1', body: `${oldMarker}\nold finding`, authorId: 'self' }] }],
    })

    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [finding] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(1)
    expect(p.inline.placed).toBe(1)
    expect(p.inline.priorRevisionThreads).toBe(1)
    expect(p.inline.priorRevisionThreadsResolved).toBe(1)
    expect(client.calls.resolveDiscussion).toHaveLength(1)
    expect(client.calls.resolveDiscussion[0]!.discussionId).toBe('old-thread')
    expect(client.calls.callOrder).toEqual(['createDiscussion', 'createNote', 'resolveDiscussion'])
  })

  it('resolveDiscussion returning false leaves the old thread untouched and the publish successful without a fallback comment', async () => {
    const finding = placeableFinding()
    const fp = threadFingerprint(finding, 0)
    const oldMarker = inlineThreadMarker('an-older-sha', fp)
    const client = fakeInlineClient({
      discussions: [{ id: 'old-thread', resolvable: true, resolved: false, notes: [{ id: 'n1', body: `${oldMarker}\nold finding`, authorId: 'self' }] }],
      resolveResult: () => false,
    })

    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [finding] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createNote).toHaveLength(1)
    expect(client.calls.callOrder).toEqual(['createDiscussion', 'createNote', 'resolveDiscussion'])
    expect(p.inline.priorRevisionThreads).toBe(1)
    expect(p.inline.priorRevisionThreadsResolved).toBe(0)
    expect(client.calls.resolveDiscussion).toEqual([{ discussionId: 'old-thread' }])
  })

  it('two findings sharing (file, lineType, title) get DIFFERENT fingerprints, and therefore two threads', async () => {
    const dupTitle = 'Duplicate title finding'
    const findingA = placeableFinding({ line: 11, title: dupTitle })
    const findingB = placeableFinding({ line: 12, title: dupTitle })
    const ordinals = assignOrdinals([findingA, findingB])
    expect(ordinals).toEqual([0, 1])
    expect(threadFingerprint(findingA, ordinals[0]!)).not.toBe(threadFingerprint(findingB, ordinals[1]!))

    const client = fakeInlineClient()
    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [findingA, findingB] },
      diffFiles,
    })
    asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(2)
    const fp1 = parseInlineThreadMarker(client.calls.createDiscussion[0]!.body)!.fingerprint
    const fp2 = parseInlineThreadMarker(client.calls.createDiscussion[1]!.body)!.fingerprint
    expect(fp1).not.toBe(fp2)
  })
})

describe('inline comments ON — a create failure falls back, never crashes the publish', () => {
  it('createDiscussion THROWING for one finding still publishes the note, still posts the other threads, counts failed, and lists the failed finding', async () => {
    const failing = placeableFinding({ line: 11, title: 'FAILS TO POST', severity: 'blocking' })
    const succeeding = placeableFinding({ line: 12, title: 'POSTS FINE', severity: 'concern' })
    const client = fakeInlineClient({
      createShouldThrow: (body) => body.includes('FAILS TO POST'),
    })

    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [failing, succeeding] },
      diffFiles,
    })
    const p = asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(2) // both attempted
    expect(p.inline.failed).toBe(1)
    expect(p.inline.placed).toBe(1)
    expect(p.body).toContain('FAILS TO POST')
    expect(p.body).toContain('### Blocking')
    expect(p.body).not.toContain('POSTS FINE')
  })
})

describe('inline comments ON — earlier steps still short-circuit before any discussion call', () => {
  it('a headSha that moved (step 3) makes ZERO discussion calls', async () => {
    const client = fakeInlineClient({ summaries: [summary({ headSha: 'a-brand-new-sha' })] })
    const result = await publisher(client, true).publish({
      job: job(),
      findings: threeFindingsDoc(),
      diffFiles,
    })
    expect(result.status).toBe('superseded')
    expect(client.calls.listDiscussions).toBe(0)
    expect(client.calls.createDiscussion).toHaveLength(0)
    expect(client.calls.resolveDiscussion).toHaveLength(0)
  })

  it('an existing summary-note marker (step 4) also makes zero discussion calls', async () => {
    const marker = reviewNoteMarker('head-sha-1')
    const client = fakeInlineClient({
      notes: [{ id: 'existing-note', body: `${marker}\nAlready reviewed.`, authorId: 'self' }],
    })
    const result = await publisher(client, true).publish({
      job: job(),
      findings: threeFindingsDoc(),
      diffFiles,
    })
    expect(result.status).toBe('already_published')
    expect(client.calls.listDiscussions).toBe(0)
    expect(client.calls.createDiscussion).toHaveLength(0)
    expect(client.calls.resolveDiscussion).toHaveLength(0)
  })
})

describe('inline comments ON — discussions are created sequentially, in severity then input order', () => {
  it('never runs two creates concurrently, and orders blocking before concern before nit regardless of input order', async () => {
    const nit = placeableFinding({ line: 11, lineType: 'added', title: 'N', severity: 'nit' })
    const blocking = placeableFinding({ line: 12, lineType: 'added', title: 'B', severity: 'blocking' })
    const concern = placeableFinding({ line: 10, lineType: 'context', title: 'C', severity: 'concern' })
    // Input order: nit, blocking, concern — deliberately NOT severity order.
    const client = fakeInlineClient()

    const result = await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [nit, blocking, concern] },
      diffFiles,
    })
    asPublished(result)

    expect(client.calls.createDiscussion).toHaveLength(3)
    expect(client.sawConcurrentCreates).toBe(false)
    const titlesInOrder = client.calls.createDiscussion.map((c) => {
      if (c.body.includes('**B**')) return 'B'
      if (c.body.includes('**C**')) return 'C'
      return 'N'
    })
    expect(titlesInOrder).toEqual(['B', 'C', 'N'])
  })
})

describe('inline comments ON — nothing sensitive ever reaches a log line', () => {
  it('a create failure and a resolve failure never leak a message or body into a log', async () => {
    const secret = 'PRIVATE-TOKEN-abc123-<html>leaked response body</html>'
    const logged: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(getLogger(), 'warn').mockImplementation(((obj: unknown) => {
      logged.push(obj as Record<string, unknown>)
      return undefined
    }) as never)

    try {
      const finding = placeableFinding()
      const fp = threadFingerprint(finding, 0)
      const oldMarker = inlineThreadMarker('an-older-sha', fp)
      const client = fakeInlineClient({
        discussions: [{ id: 'old-thread', resolvable: true, resolved: false, notes: [{ id: 'n1', body: `${oldMarker}\nold`, authorId: 'self' }] }],
        createShouldThrow: () => true,
        resolveShouldThrow: () => true,
        hostilePayload: secret,
      })

      const result = await publisher(client, true).publish({
        job: job(),
        findings: { summary: 's', findings: [finding] },
        diffFiles,
        })
      asPublished(result)

      expect(logged.length).toBeGreaterThan(0)
      const serialized = JSON.stringify(logged)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('PRIVATE-TOKEN')
      expect(serialized).not.toContain('<html>')
      // "status only" — every logged object here carries a numeric status.
      for (const l of logged) {
        if ('status' in l) expect(typeof l.status === 'number' || l.status === null).toBe(true)
      }
    } finally {
      spy.mockRestore()
    }
  })
})

describe('inline comments ON — prior-revision cleanup is logged after it has actually happened', () => {
  it('logs review_inline_prior_revision_cleanup with the counts, and resolvePermitted false on a 403', async () => {
    // The counts live in step 7, which runs AFTER review_published is logged —
    // so logging them there reported nothing while looking like it reported
    // something. A real run encountered four threads and the only evidence in
    // the log was four WARN lines about refused resolves; had the resolves
    // SUCCEEDED there would have been no evidence at all.
    const info = vi.spyOn(getLogger(), 'info')
    const fp = threadFingerprint(placeableFinding(), 0)
    const client = fakeInlineClient({
      discussions: [{
        id: 'disc-old',
        resolvable: true,
        resolved: false,
        notes: [{ id: 'n1', body: `${inlineThreadMarker('older-sha', fp)}\n\nold`, authorId: 'self' }],
      }],
      // A Reporter token cannot resolve a discussion it authored on our
      // instance: GitLab answers 403, which the client reports as false.
      resolveResult: () => false,
    })

    await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [placeableFinding()] },
      diffFiles,
    })

    const call = info.mock.calls.find((c) => c[1] === 'review_inline_prior_revision_cleanup')
    expect(call).toBeDefined()
    expect(call![0]).toMatchObject({
      priorRevisionThreads: 1,
      priorRevisionThreadsResolved: 0,
      resolvePermitted: false,
    })
    info.mockRestore()
  })

  it('stays quiet on an ordinary first review, where nothing was superseded', async () => {
    const info = vi.spyOn(getLogger(), 'info')
    const client = fakeInlineClient()

    await publisher(client, true).publish({
      job: job(),
      findings: { summary: 's', findings: [placeableFinding()] },
      diffFiles,
    })

    expect(info.mock.calls.find((c) => c[1] === 'review_inline_prior_revision_cleanup')).toBeUndefined()
    info.mockRestore()
  })
})
