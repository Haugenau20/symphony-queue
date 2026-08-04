import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FileQueueTracker,
  parseQueueItem,
  serializeQueueItem,
  QUEUE_DIRECTORIES,
  STATE_TO_DIRECTORY,
  isValidQueueId,
  type QueueItemFrontMatter,
} from '../src/tracker/file_queue.js'
import { SymphonyOrchestrator, backoffDelay } from '../src/orchestrator.js'
import { getLogger } from '../src/log.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'symphony-queue-'))
  for (const dir of Object.keys(QUEUE_DIRECTORIES)) mkdirSync(join(root, dir), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeItem(dir: string, name: string, contents: string): string {
  const p = join(root, dir, name)
  writeFileSync(p, contents, 'utf-8')
  return p
}

function item(id: string, extra = '', body = 'Do the work.'): string {
  return `---
id: ${id}
title: Item ${id}
priority: 2
labels: [bug]
blocked_by: []
branch: symphony/${id}
attempts: 0
next_retry_at: null
session_id: null
created_at: 2026-08-04T09:00:00Z
updated_at: 2026-08-04T09:00:00Z${extra ? '\n' + extra : ''}
---

${body}
`
}

function tracker(overrides?: { maxAttempts?: number }): FileQueueTracker {
  return new FileQueueTracker({ root, maxAttempts: overrides?.maxAttempts })
}

// ---------------------------------------------------------------------------

describe('front matter round-trip', () => {
  it('parse -> serialize -> parse preserves all fields', () => {
    const raw = item('SYM-001', 'jira: ABC-123')
    const first = parseQueueItem(raw)

    const reserialized = serializeQueueItem(first.frontMatter, first.body)
    const second = parseQueueItem(reserialized)

    expect(second.frontMatter).toEqual(first.frontMatter)
    expect(second.body).toBe(first.body)

    // and the values actually survived, rather than all collapsing to defaults
    expect(first.frontMatter).toMatchObject({
      id: 'SYM-001',
      title: 'Item SYM-001',
      priority: 2,
      labels: ['bug'],
      blockedBy: [],
      branch: 'symphony/SYM-001',
      jira: 'ABC-123',
      attempts: 0,
      nextRetryAt: null,
      sessionId: null,
    })
    expect(first.frontMatter.createdAt?.toISOString()).toBe('2026-08-04T09:00:00.000Z')
    expect(first.body).toContain('Do the work.')
  })

  it('round-trips a fully populated item including retry bookkeeping', () => {
    const fm: QueueItemFrontMatter = {
      id: 'SYM-042',
      title: 'Fix token refresh race',
      priority: 1,
      labels: ['bug', 'auth'],
      blockedBy: ['SYM-001', 'SYM-002'],
      branch: 'symphony/SYM-042-fix-token-refresh',
      jira: 'ABC-999',
      attempts: 3,
      nextRetryAt: new Date('2026-08-04T10:30:00Z'),
      sessionId: 'sess-abc',
      createdAt: new Date('2026-08-04T09:00:00Z'),
      updatedAt: new Date('2026-08-04T09:45:00Z'),
    }
    const body = '# Task\n\nDo it.\n\n## Workpad\n\n- [x] step one\n- [ ] step two'
    const parsed = parseQueueItem(serializeQueueItem(fm, body))
    expect(parsed.frontMatter).toEqual(fm)
    expect(parsed.body).toBe(body)
  })

  it('serializes front matter in the documented shape', () => {
    const { frontMatter, body } = parseQueueItem(item('SYM-001'))
    const out = serializeQueueItem(frontMatter, body)
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('id: SYM-001')
    expect(out).toContain('labels: [bug]')
    expect(out).toContain('\n---\n')
  })
})

describe('state comes from the directory', () => {
  it('derives Issue.state from the parent directory for every queue directory', async () => {
    for (const [dir, state] of Object.entries(QUEUE_DIRECTORIES)) {
      writeItem(dir, `${dir}-1.md`, item(`ID-${dir}`))
      expect(STATE_TO_DIRECTORY[state]).toBe(dir)
    }
    const t = tracker()
    const all = await t.fetchIssuesByStates(Object.values(QUEUE_DIRECTORIES))
    const byId = new Map(all.map((i) => [i.id, i.state]))
    for (const [dir, state] of Object.entries(QUEUE_DIRECTORIES)) {
      expect(byId.get(`ID-${dir}`)).toBe(state)
    }
  })

  it('ignores a state: key in front matter and warns', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {})
    writeItem('todo', 'a.md', item('SYM-001', 'state: Done'))

    const issues = await tracker().fetchCandidateIssues()
    expect(issues).toHaveLength(1)
    expect(issues[0]!.state).toBe('Todo')
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'SYM-001' }),
      'queue_item_state_field_ignored',
    )
  })
})

describe('updateIssueState', () => {
  it('moves the file to the target directory', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))
    const t = tracker()

    await t.updateIssueState('SYM-001', 'In Progress')

    expect(readdirSync(join(root, 'todo'))).toEqual([])
    expect(readdirSync(join(root, 'in-progress'))).toEqual(['SYM-001-x.md'])
    const [issue] = await t.fetchIssueStatesByIds(['SYM-001'])
    expect(issue!.state).toBe('In Progress')
  })

  it('is idempotent when the item is already in the target directory', async () => {
    const path = writeItem('in-progress', 'SYM-001-x.md', item('SYM-001'))
    const before = readFileSync(path, 'utf-8')
    const t = tracker()

    await expect(t.updateIssueState('SYM-001', 'In Progress')).resolves.toBeUndefined()
    expect(readdirSync(join(root, 'in-progress'))).toEqual(['SYM-001-x.md'])
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  it('does not double-count attempts when Failed is applied twice', async () => {
    writeItem('in-progress', 'SYM-001-x.md', item('SYM-001'))
    const t = tracker()

    await t.updateIssueState('SYM-001', 'Failed')
    const afterFirst = readFileSync(join(root, 'failed', 'SYM-001-x.md'), 'utf-8')
    await t.updateIssueState('SYM-001', 'Failed')

    expect(parseQueueItem(readFileSync(join(root, 'failed', 'SYM-001-x.md'), 'utf-8')).frontMatter.attempts).toBe(1)
    expect(readFileSync(join(root, 'failed', 'SYM-001-x.md'), 'utf-8')).toBe(afterFirst)
  })

  it('re-scans and succeeds when the item was relocated before the call', async () => {
    const t = tracker()
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))
    await t.fetchCandidateIssues() // whatever we saw, the disk is the truth

    // a concurrent mover relocated the file
    const moved = writeItem('review', 'SYM-001-x.md', item('SYM-001'))
    rmSync(join(root, 'todo', 'SYM-001-x.md'))
    expect(existsSync(moved)).toBe(true)

    await expect(t.updateIssueState('SYM-001', 'Done')).resolves.toBeUndefined()
    expect(readdirSync(join(root, 'review'))).toEqual([])
    expect(readdirSync(join(root, 'done'))).toEqual(['SYM-001-x.md'])
  })

  it('recovers when the file is moved between the scan and the rename', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))
    const t = tracker()

    // Simulate losing the race: the file relocates in the window between
    // locating it and renaming it, so the first rename hits ENOENT.
    const realTryMove = (t as any).tryMove.bind(t)
    let raced = false
    const spy = vi.spyOn(t as any, 'tryMove').mockImplementation(async (...args: unknown[]) => {
      if (!raced) {
        raced = true
        renameSync(join(root, 'todo', 'SYM-001-x.md'), join(root, 'review', 'SYM-001-x.md'))
      }
      return realTryMove(...args)
    })

    await expect(t.updateIssueState('SYM-001', 'Done')).resolves.toBeUndefined()
    await expect(spy.mock.results[0]!.value).resolves.toBe(false) // the first attempt really did fail
    expect(readdirSync(join(root, 'todo'))).toEqual([])
    expect(readdirSync(join(root, 'review'))).toEqual([])
    expect(readdirSync(join(root, 'done'))).toEqual(['SYM-001-x.md'])
  })

  it('gives up when the item vanishes entirely mid-flight', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))
    const t = tracker()

    const realTryMove = (t as any).tryMove.bind(t)
    let raced = false
    vi.spyOn(t as any, 'tryMove').mockImplementation(async (...args: unknown[]) => {
      if (!raced) {
        raced = true
        rmSync(join(root, 'todo', 'SYM-001-x.md'))
      }
      return realTryMove(...args)
    })

    await expect(t.updateIssueState('SYM-001', 'Done')).rejects.toThrow(/not found/i)
  })

  it('throws when the id is nowhere in the queue', async () => {
    await expect(tracker().updateIssueState('SYM-404', 'Done')).rejects.toThrow(/not found/i)
  })

  it('throws on an unknown target state', async () => {
    writeItem('todo', 'a.md', item('SYM-001'))
    await expect(tracker().updateIssueState('SYM-001', 'Nonsense')).rejects.toThrow(/unknown state/i)
  })

  it('records attempts and a backoff deadline when moving to Failed', async () => {
    writeItem('in-progress', 'SYM-001-x.md', item('SYM-001'))
    const t = tracker()
    const before = Date.now()

    await t.updateIssueState('SYM-001', 'Failed')

    const raw = readFileSync(join(root, 'failed', 'SYM-001-x.md'), 'utf-8')
    const { frontMatter } = parseQueueItem(raw)
    expect(frontMatter.attempts).toBe(1)
    const due = frontMatter.nextRetryAt!.getTime()
    expect(due).toBeGreaterThanOrEqual(before + backoffDelay(1))
    expect(due).toBeLessThanOrEqual(Date.now() + backoffDelay(1))
  })
})

describe('startup recovery', () => {
  it('returns items left behind in in-progress/', async () => {
    writeItem('in-progress', 'SYM-001-x.md', item('SYM-001'))
    writeItem('in-progress', 'SYM-002-x.md', item('SYM-002'))
    writeItem('todo', 'SYM-003-x.md', item('SYM-003'))

    const recovered = await tracker().fetchRecoverableIssues()
    expect(recovered.map((i) => i.id).sort()).toEqual(['SYM-001', 'SYM-002'])
    expect(recovered.every((i) => i.state === 'In Progress')).toBe(true)
  })

  it('re-dispatches them through the ordinary candidate path', async () => {
    writeItem('in-progress', 'SYM-001-x.md', item('SYM-001'))
    const candidates = await tracker().fetchCandidateIssues()
    expect(candidates.map((i) => i.id)).toEqual(['SYM-001'])
  })
})

describe('retry sweep', () => {
  it('does not return a failed item whose next_retry_at is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    writeItem('failed', 'SYM-001-x.md', item('SYM-001').replace('attempts: 0', 'attempts: 1').replace('next_retry_at: null', `next_retry_at: ${future}`))

    const t = tracker()
    expect(await t.fetchCandidateIssues()).toEqual([])
    expect(readdirSync(join(root, 'failed'))).toEqual(['SYM-001-x.md'])
  })

  it('sweeps a due failed item back to todo/ and returns it', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    writeItem('failed', 'SYM-001-x.md', item('SYM-001').replace('attempts: 0', 'attempts: 1').replace('next_retry_at: null', `next_retry_at: ${past}`))

    const t = tracker()
    const candidates = await t.fetchCandidateIssues()

    expect(candidates.map((i) => i.id)).toEqual(['SYM-001'])
    expect(candidates[0]!.state).toBe('Todo')
    expect(readdirSync(join(root, 'failed'))).toEqual([])
    expect(readdirSync(join(root, 'todo'))).toEqual(['SYM-001-x.md'])
    // attempts are preserved across the sweep so backoff keeps growing
    const { frontMatter } = parseQueueItem(readFileSync(join(root, 'todo', 'SYM-001-x.md'), 'utf-8'))
    expect(frontMatter.attempts).toBe(1)
    expect(frontMatter.nextRetryAt).toBeNull()
  })

  it('leaves an item past max attempts in failed/ forever', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    writeItem('failed', 'SYM-001-x.md', item('SYM-001').replace('attempts: 0', 'attempts: 5').replace('next_retry_at: null', `next_retry_at: ${past}`))

    const t = tracker({ maxAttempts: 5 })
    expect(await t.fetchCandidateIssues()).toEqual([])
    expect(readdirSync(join(root, 'failed'))).toEqual(['SYM-001-x.md'])
  })
})

describe('path safety and untrusted input', () => {
  it('rejects a traversal id and writes nothing outside the root', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {})
    const outside = join(root, '..', 'symphony-escape-probe')
    rmSync(outside, { recursive: true, force: true })

    writeItem('todo', 'evil.md', item('../../etc/passwd'))
    writeItem('todo', 'evil2.md', item('/etc/passwd'))
    writeItem('todo', 'evil3.md', item('..'))

    const t = tracker()
    expect(await t.fetchCandidateIssues()).toEqual([])
    expect(warn).toHaveBeenCalled()

    await expect(t.updateIssueState('../../etc/passwd', 'Done')).rejects.toThrow()
    expect(existsSync(outside)).toBe(false)
    expect(existsSync('/etc/passwd-x')).toBe(false)
    // the offending files are left alone for a human, never deleted
    expect(readdirSync(join(root, 'todo')).sort()).toEqual(['evil.md', 'evil2.md', 'evil3.md'])
  })

  it('validates ids', () => {
    expect(isValidQueueId('SYM-001')).toBe(true)
    expect(isValidQueueId('a')).toBe(true)
    expect(isValidQueueId('A.b_c-1')).toBe(true)
    expect(isValidQueueId('../../etc/passwd')).toBe(false)
    expect(isValidQueueId('..')).toBe(false)
    expect(isValidQueueId('.hidden')).toBe(false)
    expect(isValidQueueId('-leading-dash')).toBe(false)
    expect(isValidQueueId('has/slash')).toBe(false)
    expect(isValidQueueId('has space')).toBe(false)
    expect(isValidQueueId('')).toBe(false)
    expect(isValidQueueId('x'.repeat(129))).toBe(false)
  })

  it('never lets a crafted id escape the root on write', async () => {
    const t = tracker()
    await expect(t.createItem({ id: '../../escaped', title: 'nope' })).rejects.toThrow()
    expect(existsSync(join(root, '..', '..', 'escaped'))).toBe(false)
  })
})

describe('malformed items', () => {
  it('skips a malformed file with a warning instead of throwing', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {})
    writeItem('todo', 'good.md', item('SYM-001'))
    writeItem('todo', 'no-front-matter.md', 'just a body, no front matter at all')
    writeItem('todo', 'bad-yaml.md', '---\nid: [unclosed\n---\nbody')
    writeItem('todo', 'wrong-types.md', '---\nid: 12345\ntitle: []\n---\nbody')
    writeItem('todo', 'missing-title.md', '---\nid: SYM-999\n---\nbody')

    const t = tracker()
    const issues = await t.fetchCandidateIssues()

    expect(issues.map((i) => i.id)).toEqual(['SYM-001'])
    expect(warn).toHaveBeenCalled()
    // nothing was deleted or rewritten
    expect(readdirSync(join(root, 'todo')).length).toBe(5)
  })

  it('does not throw out of an orchestrator tick', async () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {})
    writeItem('todo', 'bad.md', '---\nnot: valid\n---\n')
    writeItem('todo', 'good.md', item('SYM-001'))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: 's', success: true, turnsCompleted: 1 })) }
    const orch = new SymphonyOrchestrator({ tracker: tracker(), agentRunner: agentRunner as any, promptTemplate: '' })

    await expect((orch as any).tick()).resolves.toBeUndefined()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))
    expect(agentRunner.run).toHaveBeenCalledTimes(1)
  })
})

describe('candidate selection', () => {
  it('returns only todo/ and in-progress/, never review/', async () => {
    writeItem('todo', 'a.md', item('SYM-001'))
    writeItem('in-progress', 'b.md', item('SYM-002'))
    writeItem('review', 'c.md', item('SYM-003'))
    writeItem('done', 'd.md', item('SYM-004'))
    writeItem('cancelled', 'e.md', item('SYM-005'))

    const issues = await tracker().fetchCandidateIssues()
    expect(issues.map((i) => i.id).sort()).toEqual(['SYM-001', 'SYM-002'])
    expect(issues.map((i) => i.state).sort()).toEqual(['In Progress', 'Todo'])
  })

  it('returns an empty result without touching disk for empty inputs', async () => {
    writeItem('todo', 'a.md', item('SYM-001'))
    const t = tracker()
    expect(await t.fetchIssuesByStates([])).toEqual([])
    expect(await t.fetchIssueStatesByIds([])).toEqual([])
  })

  it('omits ids that are not present', async () => {
    writeItem('todo', 'a.md', item('SYM-001'))
    const found = await tracker().fetchIssueStatesByIds(['SYM-001', 'SYM-404'])
    expect(found.map((i) => i.id)).toEqual(['SYM-001'])
  })

  it('resolves blocked_by against the rest of the queue', async () => {
    writeItem('todo', 'a.md', item('SYM-001').replace('blocked_by: []', 'blocked_by: [SYM-002, SYM-404]'))
    writeItem('review', 'b.md', item('SYM-002'))

    const [issue] = await tracker().fetchCandidateIssues()
    expect(issue!.blockedBy).toEqual([
      { id: 'SYM-002', identifier: 'SYM-002', state: 'In Review' },
      { id: 'SYM-404', identifier: 'SYM-404', state: null },
    ])
  })
})

describe('createItem', () => {
  it('writes a valid item into todo/ that parses back', async () => {
    const t = tracker()
    const created = await t.createItem({ id: 'SYM-010', title: 'Fix token refresh race', priority: 2, labels: ['bug'] })

    expect(created.state).toBe('Todo')
    const files = readdirSync(join(root, 'todo'))
    expect(files).toEqual(['SYM-010-fix-token-refresh-race.md'])

    const [issue] = await t.fetchCandidateIssues()
    expect(issue).toMatchObject({ id: 'SYM-010', title: 'Fix token refresh race', priority: 2, labels: ['bug'], state: 'Todo' })
  })

  it('refuses to overwrite an existing id', async () => {
    const t = tracker()
    await t.createItem({ id: 'SYM-010', title: 'first' })
    await expect(t.createItem({ id: 'SYM-010', title: 'second' })).rejects.toThrow(/exists/i)
  })
})

describe('layout', () => {
  it('creates the six queue directories when asked', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'symphony-queue-fresh-'))
    try {
      new FileQueueTracker({ root: fresh, createIfMissing: true })
      expect(readdirSync(fresh).sort()).toEqual(Object.keys(QUEUE_DIRECTORIES).sort())
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('throws for a missing root when not asked to create it', () => {
    expect(() => new FileQueueTracker({ root: join(root, 'nope') })).toThrow(/queue root/i)
  })

  it('tolerates unexpected entries in the queue root', async () => {
    writeFileSync(join(root, 'README.md'), 'humans read this')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeItem('todo', 'a.md', item('SYM-001'))
    writeItem('todo', 'notes.txt', 'not a queue item')

    const issues = await tracker().fetchCandidateIssues()
    expect(issues.map((i) => i.id)).toEqual(['SYM-001'])
  })
})

describe('full tick loop against FileQueueTracker', () => {
  it('dispatches from todo/, moves the file to in-progress/, and runs the agent', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))
    writeItem('review', 'SYM-002-x.md', item('SYM-002'))

    const seen: string[] = []
    const agentRunner = {
      run: vi.fn(async (issue: { id: string }, prompt: string) => {
        seen.push(`${issue.id}|${prompt}`)
        return { sessionId: 'sess-1', success: true, turnsCompleted: 1 }
      }),
    }

    const t = tracker()
    const orch = new SymphonyOrchestrator({
      tracker: t,
      agentRunner: agentRunner as any,
      promptTemplate: 'Work on {{ issue.identifier }}: {{ issue.title }}.',
      terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(agentRunner.run).toHaveBeenCalledTimes(1)
    expect(seen[0]).toBe('SYM-001|Work on SYM-001: Item SYM-001.')

    // The claim was the rename out of todo/, and the clean exit renamed it on
    // into review/ — the human gate. Nothing may be left in in-progress/, or
    // the next process start would re-dispatch a run that already happened.
    expect(readdirSync(join(root, 'todo'))).toEqual([])
    expect(readdirSync(join(root, 'in-progress'))).toEqual([])
    expect(readdirSync(join(root, 'review')).sort()).toEqual(['SYM-001-x.md', 'SYM-002-x.md'])
    expect(orch.state.completed.has('SYM-001')).toBe(true)
  })

  it('moves the file to failed/ and stamps the retry deadline when the run fails', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0 })) }
    const orch = new SymphonyOrchestrator({
      tracker: tracker(), agentRunner: agentRunner as any, promptTemplate: '',
      terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(readdirSync(join(root, 'in-progress'))).toEqual([])
    expect(readdirSync(join(root, 'failed'))).toEqual(['SYM-001-x.md'])

    // The durable counters are what survive a restart, so they must actually
    // be written — not just tracked in the orchestrator's memory.
    const parsed = parseQueueItem(readFileSync(join(root, 'failed', 'SYM-001-x.md'), 'utf-8'))
    expect(parsed.frontMatter.attempts).toBe(1)
    expect(parsed.frontMatter.nextRetryAt).not.toBeNull()
    expect(parsed.frontMatter.nextRetryAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('re-dispatches nothing on a second tick once the queue is drained', async () => {
    writeItem('todo', 'SYM-001-x.md', item('SYM-001'))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: 's', success: true, turnsCompleted: 1 })) }
    const t = tracker()
    const orch = new SymphonyOrchestrator({
      tracker: t, agentRunner: agentRunner as any, promptTemplate: '',
      terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    // A fresh orchestrator over the same queue root is exactly what a restart
    // looks like: no in-memory `completed` set to protect the item.
    const restarted = new SymphonyOrchestrator({
      tracker: t, agentRunner: agentRunner as any, promptTemplate: '',
      terminalStates: ['Done', 'Cancelled'],
    })
    await (restarted as any).tick()
    await Promise.all(Array.from(restarted.state.running.values()).map((e) => e.task))

    expect(agentRunner.run).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch an item blocked by a non-terminal item', async () => {
    writeItem('todo', 'a.md', item('SYM-001').replace('blocked_by: []', 'blocked_by: [SYM-002]'))
    writeItem('todo', 'b.md', item('SYM-002'))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: 's', success: true, turnsCompleted: 1 })) }
    const orch = new SymphonyOrchestrator({
      tracker: tracker(), agentRunner: agentRunner as any, promptTemplate: '',
      terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    const dispatched = agentRunner.run.mock.calls.map((c: any[]) => c[0].id)
    expect(dispatched).toEqual(['SYM-002'])
  })

  it('startup cleanup can enumerate terminal items', async () => {
    writeItem('done', 'a.md', item('SYM-001'))
    writeItem('cancelled', 'b.md', item('SYM-002'))
    const terminal = await tracker().fetchIssuesByStates(['Done', 'Cancelled'])
    expect(terminal.map((i) => i.identifier).sort()).toEqual(['SYM-001', 'SYM-002'])
  })
})
