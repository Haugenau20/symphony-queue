import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentFindingsCritic } from '../../src/review/critique.js'
import { AgentRunner } from '../../src/agent_runner.js'
import { REVIEW_PERMISSIONS } from '../../src/review/worker.js'
import { IMPLEMENTATION_PERMISSIONS } from '../../src/agent_runner.js'
import type { RunTarget } from '../../src/agent_runner.js'
import type { Finding, FindingsDocument, ReviewJob, ReviewJobKey } from '../../src/review/types.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function key(overrides: Partial<ReviewJobKey> = {}): ReviewJobKey {
  return { projectId: 'my-org/service-a', mrIid: 412, headSha: 'deadbeef00cafe11', ...overrides }
}

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    key: key(),
    baseSha: 'base123',
    startSha: 'start123',
    title: 'Fix the thing',
    webUrl: 'https://gitlab.example/my-org/service-a/-/merge_requests/412',
    state: 'running',
    attempts: 0,
    nextRetryAt: null,
    discoveredAt: new Date('2026-08-10T09:14:22.000Z'),
    publishedNoteId: null,
    skipReason: null,
    ...overrides,
  }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'concern',
    file: 'src/foo.ts',
    line: 2,
    lineType: 'added',
    title: 'A finding',
    detail: 'Some detail about the finding.',
    suggestion: null,
    ...overrides,
  }
}

function fiveFindings(): FindingsDocument {
  return {
    summary: 'First pass summary.',
    findings: [
      finding({ title: 'Finding zero', file: 'a.ts', detail: 'detail zero' }),
      finding({ title: 'Finding one', file: 'b.ts', detail: 'detail one' }),
      finding({ title: 'Finding two', file: 'c.ts', detail: 'detail two' }),
      finding({ title: 'Finding three', file: 'd.ts', detail: 'detail three' }),
      finding({ title: 'Finding four', file: 'e.ts', detail: 'detail four' }),
    ],
  }
}

let root: string
let ws: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'symphony-critique-'))
  ws = join(root, 'sandbox')
  require('node:fs').mkdirSync(ws, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Fake agent run that writes CRITIQUE.json into the workspace it was handed. */
function agentWritingCritique(critiqueJson: unknown) {
  const promptCalls: string[] = []
  const permissionCalls: unknown[] = []
  const runFn = vi.fn(
    async (
      _target: RunTarget,
      prompt: string,
      workspacePath: string | null | undefined,
      _signal: AbortSignal | undefined,
      options: { permissions: unknown },
    ) => {
      promptCalls.push(prompt)
      permissionCalls.push(options.permissions)
      if (workspacePath) {
        writeFileSync(join(workspacePath, 'CRITIQUE.json'), JSON.stringify(critiqueJson))
      }
      return { sessionId: 's1', success: true, turnsCompleted: 1, stopReason: 'completed' as const }
    },
  )
  return { run: runFn, promptCalls, permissionCalls }
}

function critic(overrides: Partial<{ agentRunner: Pick<AgentRunner, 'run'>; timeoutMs: number }> = {}) {
  return new AgentFindingsCritic({
    agentRunner: overrides.agentRunner ?? agentWritingCritique({ kept: [], dropped: [], summary: 'n/a' }),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  })
}

// ---------------------------------------------------------------------------

describe('AgentFindingsCritic — permissions', () => {
  it('runs the critic with REVIEW_PERMISSIONS: edit allow, external_directory allow, bash deny, webfetch deny', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 'kept all' })
    const c = critic({ agentRunner: agent })

    await c.critique({ findings, workspacePath: ws, job: job() })

    expect(agent.run).toHaveBeenCalledTimes(1)
    const passedPermissions = agent.permissionCalls[0]

    // Asserted on the SET ACTUALLY PASSED to run() — not a copy, not the
    // REVIEW_PERMISSIONS constant compared to itself.
    expect(passedPermissions).toBe(REVIEW_PERMISSIONS)
    expect(passedPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'edit', action: 'allow' }),
        expect.objectContaining({ permission: 'external_directory', action: 'allow' }),
        expect.objectContaining({ permission: 'bash', action: 'deny' }),
        expect.objectContaining({ permission: 'webfetch', action: 'deny' }),
      ]),
    )
  })

  it('imports the permission set from worker.ts rather than restating it — differs from IMPLEMENTATION_PERMISSIONS in exactly bash and webfetch', () => {
    const asMap = (rules: typeof REVIEW_PERMISSIONS) => Object.fromEntries(rules.map((r) => [r.permission, r.action]))
    const impl = asMap(IMPLEMENTATION_PERMISSIONS)
    const review = asMap(REVIEW_PERMISSIONS)
    const differing = Object.keys(impl).filter((k) => impl[k] !== review[k]).sort()
    expect(differing).toEqual(['bash', 'webfetch'])
  })
})

describe('AgentFindingsCritic — keeping a subset', () => {
  it('a critic keeping 2 of 5 findings returns exactly those 2, in input order, byte-identical to the input', async () => {
    const findings = fiveFindings()
    // Deliberately out of order in CRITIQUE.json (3 before 1), to prove the
    // result is re-sorted to INPUT order, not emission order.
    const agent = agentWritingCritique({
      kept: [3, 1],
      dropped: [
        { index: 0, reason: 'wrong about the diff' },
        { index: 2, reason: 'style preference' },
        { index: 4, reason: 'duplicate of finding 1' },
      ],
      summary: 'Two solid findings remain.',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') throw new Error('unreachable')
    expect(result.findings.findings).toHaveLength(2)
    // Input order: index 1 before index 3.
    expect(result.findings.findings[0]).toEqual(findings.findings[1])
    expect(result.findings.findings[1]).toEqual(findings.findings[3])
    // Byte-identical: the SAME content, not a critic-authored rewrite.
    expect(result.findings.findings[0]).toBe(findings.findings[1])
    expect(result.findings.findings[1]).toBe(findings.findings[3])
  })

  it('dropping everything is a valid outcome', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [],
      dropped: findings.findings.map((_, i) => ({ index: i, reason: 'not worth a colleague\'s time' })),
      summary: 'Nothing survived review.',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') throw new Error('unreachable')
    expect(result.findings.findings).toEqual([])
    expect(result.outcome.keptCount).toBe(0)
    expect(result.outcome.droppedCount).toBe(5)
  })

  it('keeping everything is a valid outcome', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 'All findings hold up.' })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') throw new Error('unreachable')
    expect(result.findings.findings).toEqual(findings.findings)
    expect(result.outcome.droppedCount).toBe(0)
  })

  it('droppedCount and dropped[] agree, and dropped reasons are carried through verbatim', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [2],
      dropped: [
        { index: 0, reason: 'VERBATIM REASON ZERO' },
        { index: 1, reason: 'VERBATIM REASON ONE' },
        { index: 3, reason: 'VERBATIM REASON THREE' },
        { index: 4, reason: 'VERBATIM REASON FOUR' },
      ],
      summary: 'One finding kept.',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') throw new Error('unreachable')
    expect(result.outcome.droppedCount).toBe(result.outcome.dropped.length)
    expect(result.outcome.droppedCount).toBe(4)
    const reasons = result.outcome.dropped.map((d) => d.reason).sort()
    expect(reasons).toEqual(
      ['VERBATIM REASON ZERO', 'VERBATIM REASON ONE', 'VERBATIM REASON THREE', 'VERBATIM REASON FOUR'].sort(),
    )
    // The dropped entries also carry the original finding's file/title, for
    // the operator log — not the critic's own words for those fields.
    const zero = result.outcome.dropped.find((d) => d.reason === 'VERBATIM REASON ZERO')
    expect(zero).toEqual({ title: 'Finding zero', file: 'a.ts', reason: 'VERBATIM REASON ZERO' })
  })

  it('sets outcome.ran to true and CritiqueOutcome.kind to critiqued on success', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({ kept: [0], dropped: [{ index: 1, reason: 'r' }, { index: 2, reason: 'r' }, { index: 3, reason: 'r' }, { index: 4, reason: 'r' }], summary: 's' })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') throw new Error('unreachable')
    expect(result.outcome.ran).toBe(true)
  })
})

describe('AgentFindingsCritic — REVIEW_FINDINGS.json is written into the sandbox', () => {
  it('writes the first pass findings as REVIEW_FINDINGS.json before running the agent', async () => {
    const findings = fiveFindings()
    let seenAtRunTime: string | null = null
    const agent = {
      run: vi.fn(async (_t: RunTarget, _p: string, wsPath: string | null | undefined) => {
        if (wsPath && existsSync(join(wsPath, 'REVIEW_FINDINGS.json'))) {
          seenAtRunTime = readFileSync(join(wsPath, 'REVIEW_FINDINGS.json'), 'utf8')
        }
        if (wsPath) writeFileSync(join(wsPath, 'CRITIQUE.json'), JSON.stringify({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 's' }))
        return { sessionId: 's', success: true, turnsCompleted: 1, stopReason: 'completed' as const }
      }),
    }
    const c = critic({ agentRunner: agent })

    await c.critique({ findings, workspacePath: ws, job: job() })

    expect(seenAtRunTime).not.toBeNull()
    expect(JSON.parse(seenAtRunTime!)).toEqual(findings)
  })
})

describe('AgentFindingsCritic — rejecting a malformed CRITIQUE.json', () => {
  it('indices that do not cover every input exactly once are REJECTED -> unavailable, not a partial keep', async () => {
    const findings = fiveFindings()
    // Only covers 0..3; index 4 is missing entirely.
    const agent = agentWritingCritique({ kept: [0, 1], dropped: [{ index: 2, reason: 'r' }, { index: 3, reason: 'r' }], summary: 's' })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('an out-of-range index is rejected -> unavailable', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [0, 1, 2, 3],
      dropped: [{ index: 99, reason: 'not a real index' }],
      summary: 's',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('an index appearing in both kept and dropped is rejected -> unavailable', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [0, 1, 2, 3, 4],
      dropped: [{ index: 2, reason: 'also dropped' }],
      summary: 's',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('rejects an unknown top-level key (strict schema, like FINDINGS.json)', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [0, 1, 2, 3, 4],
      dropped: [],
      summary: 's',
      sneaky_extra_field: 'smuggled',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('rejects an unknown key inside a dropped entry', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({
      kept: [0, 1, 2, 3],
      dropped: [{ index: 4, reason: 'r', extra: 'nope' }],
      summary: 's',
    })
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('rejects invalid JSON entirely', async () => {
    const findings = fiveFindings()
    const agent = {
      run: vi.fn(async (_t: RunTarget, _p: string, wsPath: string | null | undefined) => {
        if (wsPath) writeFileSync(join(wsPath, 'CRITIQUE.json'), '{ not json')
        return { sessionId: 's', success: true, turnsCompleted: 1, stopReason: 'completed' as const }
      }),
    }
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })
})

describe('AgentFindingsCritic — failure is never fatal', () => {
  it('the agent throwing returns unavailable and does NOT throw', async () => {
    const findings = fiveFindings()
    const agent = { run: vi.fn(async () => { throw new Error('critique agent exploded') }) }
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).toContain('critique agent exploded')
  })

  it('the agent writing nothing returns unavailable and does NOT throw', async () => {
    const findings = fiveFindings()
    const agent = {
      run: vi.fn(async () => ({ sessionId: 's', success: true, turnsCompleted: 1, stopReason: 'completed' as const })),
    }
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  })

  it('an agent run reporting success: false returns unavailable and does NOT throw', async () => {
    const findings = fiveFindings()
    const agent = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0, error: 'agent run failed' })) }
    const c = critic({ agentRunner: agent })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).toContain('agent run failed')
  })

  it('a timeout returns unavailable and does NOT throw', async () => {
    const findings = fiveFindings()
    const neverSettles = {
      run: vi.fn(
        (_t: RunTarget, _p: string, _ws: string | null | undefined, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    }
    const c = critic({ agentRunner: neverSettles, timeoutMs: 30 })

    const result = await c.critique({ findings, workspacePath: ws, job: job() })

    expect(result.kind).toBe('unavailable')
  }, 5000)
})

describe('AgentFindingsCritic — no MR-authored text in the prompt', () => {
  it('the prompt passed to run() contains no merge-request title or description text', async () => {
    const findings = fiveFindings()
    const distinctiveTitle = 'ZQXJ-DISTINCTIVE-MR-TITLE-STRING-77213'
    const agent = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 's' })
    const c = critic({ agentRunner: agent })

    await c.critique({ findings, workspacePath: ws, job: job({ title: distinctiveTitle }) })

    expect(agent.promptCalls).toHaveLength(1)
    expect(agent.promptCalls[0]).not.toContain(distinctiveTitle)
  })

  it('the prompt is static across two different jobs (byte-identical, never templated)', async () => {
    const findings = fiveFindings()
    const agentA = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 's' })
    const cA = critic({ agentRunner: agentA })
    await cA.critique({ findings, workspacePath: ws, job: job({ title: 'Title A' }) })

    const ws2 = join(root, 'sandbox2')
    require('node:fs').mkdirSync(ws2, { recursive: true })
    const agentB = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 's' })
    const cB = critic({ agentRunner: agentB })
    await cB.critique({ findings, workspacePath: ws2, job: job({ title: 'A Completely Different Title' }) })

    expect(agentA.promptCalls[0]).toBe(agentB.promptCalls[0])
  })

  it('the prompt tells the critic its job is to remove, not add, findings', async () => {
    const findings = fiveFindings()
    const agent = agentWritingCritique({ kept: [0, 1, 2, 3, 4], dropped: [], summary: 's' })
    const c = critic({ agentRunner: agent })

    await c.critique({ findings, workspacePath: ws, job: job() })

    expect(agent.promptCalls[0]).toMatch(/not to add/i)
  })
})

describe('AgentFindingsCritic — against the REAL AgentRunner, not a run() fake', () => {
  // Every other test here injects a fake `run`, which means they all agree
  // with whatever this module ASSUMES about the runner. The assumption worth
  // checking is not obvious and is load-bearing: the critic passes
  // `shouldContinue: async () => false`, so the turn loop breaks immediately
  // after the first turn with stopReason 'issue_inactive'. If that counted as
  // a failed run, EVERY critique in production would return 'unavailable' and
  // every review would publish uncritiqued — with a fully green suite, because
  // no fake would ever show it. AgentRunner returns success: true there, and
  // this test is what actually proves it.
  function realRunner(reply: string, onCreate: () => void) {
    const client = {
      session: {
        create: vi.fn(async () => { onCreate(); return { data: { id: 's1' } } }),
        prompt: vi.fn().mockResolvedValue({ data: { parts: [{ type: 'text', text: reply }] } }),
      },
      v2: {
        session: {
          events: vi.fn(async () => ({
            stream: (async function* () { await new Promise(() => {}) })(),
          })),
        },
      },
    } as unknown as ConstructorParameters<typeof AgentRunner>[0]
    return new AgentRunner(client, { maxTurns: 5 })
  }

  it('a single-turn critique that never emits a completion marker still lands as critiqued', async () => {
    // The real agent writes CRITIQUE.json during its turn; the fake session
    // writes it when the session is created, which is the same ordering from
    // this module's point of view.
    const runner = realRunner('I have finished, with no marker line.', () => {
      writeFileSync(
        join(ws, 'CRITIQUE.json'),
        JSON.stringify({
          kept: [0, 2, 3, 4],
          dropped: [{ index: 1, reason: 'style preference' }],
          summary: 'revised',
        }),
      )
    })

    const result = await new AgentFindingsCritic({ agentRunner: runner })
      .critique({ findings: fiveFindings(), workspacePath: ws, job: job() })

    expect(result.kind).toBe('critiqued')
    if (result.kind !== 'critiqued') return
    expect(result.findings.findings).toHaveLength(4)
    expect(result.outcome.droppedCount).toBe(1)
    expect(result.outcome.dropped[0]!.reason).toBe('style preference')
  })
})
