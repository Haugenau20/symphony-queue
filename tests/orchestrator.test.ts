import { describe, it, expect, vi } from 'vitest'
import { shouldDispatch, dispatchKey, availableSlots, backoffDelay, SymphonyOrchestrator } from '../src/orchestrator.js'
import { createOrchestratorState } from '../src/models.js'
import { MemoryTracker } from '../src/tracker/memory.js'
import type { Issue } from '../src/models.js'

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1', identifier: 'TICKET-1', title: 'Test', state: 'In Progress',
    description: null, priority: null, branchName: null, url: null,
    labels: [], blockedBy: [], createdAt: null, updatedAt: null,
    ...overrides,
  }
}

describe('dispatchKey', () => {
  it('sorts by priority ascending', () => {
    const a = makeIssue({ identifier: 'A-1', priority: 1 })
    const b = makeIssue({ identifier: 'B-1', priority: 2 })
    expect(dispatchKey(a) < dispatchKey(b)).toBe(true)
  })
  it('sorts null priority last', () => {
    const a = makeIssue({ identifier: 'A-1', priority: null })
    const b = makeIssue({ identifier: 'B-1', priority: 1 })
    expect(dispatchKey(a) > dispatchKey(b)).toBe(true)
  })
})

describe('shouldDispatch', () => {
  it('allows eligible issue', () => {
    const issue = makeIssue({ id: '1', identifier: 'A-1', state: 'Todo' })
    expect(shouldDispatch(issue, createOrchestratorState())).toBe(true)
  })
  it('rejects already running issue', () => {
    const issue = makeIssue({ id: '1', identifier: 'A-1', state: 'Todo' })
    const state = createOrchestratorState(); state.running.set('1', {} as any)
    expect(shouldDispatch(issue, state)).toBe(false)
  })
  it('rejects claimed issue', () => {
    const issue = makeIssue({ id: '1', identifier: 'A-1', state: 'Todo' })
    const state = createOrchestratorState(); state.claimed.add('1')
    expect(shouldDispatch(issue, state)).toBe(false)
  })
  it('rejects todo with active blockers', () => {
    const issue = makeIssue({
      id: '1', identifier: 'A-1', state: 'Todo',
      blockedBy: [{ id: 'b1', identifier: 'B-1', state: 'In Progress' }],
    })
    expect(shouldDispatch(issue, createOrchestratorState())).toBe(false)
  })
  it('allows todo whose blockers are all terminal', () => {
    const issue = makeIssue({
      id: '1', identifier: 'A-1', state: 'Todo',
      blockedBy: [{ id: 'b1', identifier: 'B-1', state: 'Done' }],
    })
    expect(shouldDispatch(issue, createOrchestratorState())).toBe(true)
  })
  it('rejects an issue in a non-active state', () => {
    const issue = makeIssue({ id: '1', identifier: 'A-1', state: 'In Review' })
    expect(shouldDispatch(issue, createOrchestratorState())).toBe(false)
  })
})

describe('availableSlots', () => {
  it('returns max when no running', () => {
    expect(availableSlots(createOrchestratorState({ maxConcurrentAgents: 10 }))).toBe(10)
  })
})

describe('backoffDelay', () => {
  it('caps at maxBackoffMs', () => { expect(backoffDelay(10, 300000)).toBe(300000) })
  it('computes exponential delay', () => {
    expect(backoffDelay(1)).toBe(10000)
    expect(backoffDelay(2)).toBe(20000)
    expect(backoffDelay(3)).toBe(40000)
  })
  it('treats attempt 0 as attempt 1', () => {
    expect(backoffDelay(0)).toBe(10000)
  })
})

describe('startupCleanup', () => {
  it('calls workspaceManager.removeForIssue for terminal issues', async () => {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([
        makeIssue({ id: 'done-1', identifier: 'TICKET-1', state: 'Done' }),
      ]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
    }
    const agentRunner = { run: vi.fn() }
    const workspaceManager = { removeForIssue: vi.fn(), createForIssue: vi.fn(), runBeforeRun: vi.fn(), runAfterRun: vi.fn() }
    const orch = new SymphonyOrchestrator({
      tracker: tracker as any,
      agentRunner: agentRunner as any,
      workspaceManager: workspaceManager as any,
    })

    await (orch as any).startupCleanup()

    expect(workspaceManager.removeForIssue).toHaveBeenCalledWith('TICKET-1')
    expect(tracker.fetchIssuesByStates).toHaveBeenCalled()
  })
})

describe('orchestrator reconciliation Part B', () => {
  it('terminates runs for issues that moved to terminal state', async () => {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([
        makeIssue({ id: 'run-1', state: 'Done' }),
      ]),
    }
    const agentRunner = { run: vi.fn() }
    const orch = new SymphonyOrchestrator({ tracker: tracker as any, agentRunner: agentRunner as any })

    orch.state.running.set('run-1', {
      issueId: 'run-1', identifier: 'TICKET-1',
      issue: makeIssue({ id: 'run-1', state: 'In Progress' }),
      sessionId: null, lastAgentEvent: null, lastAgentTimestamp: null, lastAgentMessage: '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      lastReportedInputTokens: 0, lastReportedOutputTokens: 0, lastReportedTotalTokens: 0,
      retryAttempt: 0, startedAt: new Date(),
      task: Promise.resolve(), cancel: null,
      session: null,
    })
    orch.state.claimed.add('run-1')

    const state = await orch.reconcileTrackerStates()
    expect(state.running.has('run-1')).toBe(false)
    expect(state.claimed.has('run-1')).toBe(false)
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledWith(['run-1'])
  })

  it('keeps running issues that are still active', async () => {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([
        makeIssue({ id: 'run-1', state: 'In Progress' }),
      ]),
    }
    const agentRunner = { run: vi.fn() }
    const orch = new SymphonyOrchestrator({ tracker: tracker as any, agentRunner: agentRunner as any })

    orch.state.running.set('run-1', {
      issueId: 'run-1', identifier: 'TICKET-1',
      issue: makeIssue({ id: 'run-1', state: 'In Progress' }),
      sessionId: null, lastAgentEvent: null, lastAgentTimestamp: null, lastAgentMessage: '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      lastReportedInputTokens: 0, lastReportedOutputTokens: 0, lastReportedTotalTokens: 0,
      retryAttempt: 0, startedAt: new Date(),
      task: Promise.resolve(), cancel: null,
      session: null,
    })

    const state = await orch.reconcileTrackerStates()
    expect(state.running.has('run-1')).toBe(true)
  })
})

describe('orchestrator tick against MemoryTracker', () => {
  it('dispatches an eligible Todo issue through a stubbed agent runner', async () => {
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-1', identifier: 'SYM-001', title: 'Do the thing', state: 'Todo', priority: 1 }))
    tracker.addIssue(makeIssue({ id: 'q-2', identifier: 'SYM-002', title: 'Not yet', state: 'In Review' }))

    const seen: Array<{ issueId: string; prompt: string }> = []
    const agentRunner = {
      run: vi.fn(async (issue: Issue, prompt: string) => {
        seen.push({ issueId: issue.id, prompt })
        return { sessionId: 'sess-1', success: true, turnsCompleted: 1 }
      }),
    }

    const orch = new SymphonyOrchestrator({
      tracker,
      agentRunner: agentRunner as any,
      promptTemplate: 'Work on {{ issue.identifier }}: {{ issue.title }}.',
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(agentRunner.run).toHaveBeenCalledTimes(1)
    expect(seen[0]!.issueId).toBe('q-1')
    expect(seen[0]!.prompt).toBe('Work on SYM-001: Do the thing.')

    // Todo -> In Progress is written back through the tracker before the run starts.
    const [refreshed] = await tracker.fetchIssueStatesByIds(['q-1'])
    expect(refreshed!.state).toBe('In Progress')

    // A clean exit clears the claim and marks the issue completed.
    expect(orch.state.running.has('q-1')).toBe(false)
    expect(orch.state.claimed.has('q-1')).toBe(false)
    expect(orch.state.completed.has('q-1')).toBe(true)
  })

  it('schedules a backoff retry when the agent runner fails', async () => {
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-3', identifier: 'SYM-003', state: 'Todo' }))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0 })) }
    const orch = new SymphonyOrchestrator({ tracker, agentRunner: agentRunner as any, promptTemplate: '' })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(orch.state.completed.has('q-3')).toBe(false)
    expect(orch.state.claimed.has('q-3')).toBe(true)
    const retry = orch.state.retryAttempts.get('q-3')
    expect(retry?.attempt).toBe(1)
    expect(retry?.dueAtMs).toBeGreaterThan(Date.now())
  })

  it('survives a tracker whose candidate fetch throws', async () => {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockRejectedValue(new Error('queue unreadable')),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      updateIssueState: vi.fn(),
    }
    const orch = new SymphonyOrchestrator({ tracker: tracker as any, agentRunner: { run: vi.fn() } as any })
    await expect((orch as any).tick()).resolves.toBeUndefined()
    expect(orch.state.running.size).toBe(0)
  })
})
