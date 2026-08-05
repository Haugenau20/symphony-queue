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

function runningEntry(issueId: string, identifier: string) {
  return {
    session: null, issueId, identifier, issue: makeIssue({ id: issueId, identifier }),
    sessionId: null, lastAgentEvent: null, lastAgentTimestamp: null, lastAgentMessage: '',
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    lastReportedInputTokens: 0, lastReportedOutputTokens: 0, lastReportedTotalTokens: 0,
    retryAttempt: 0, startedAt: new Date(), task: Promise.resolve(), cancel: null,
  } as any
}

function stubWorkspaceManager() {
  return {
    removeForIssue: vi.fn(), createForIssue: vi.fn(),
    runAfterCreate: vi.fn(), runBeforeRun: vi.fn(), runAfterRun: vi.fn(),
  }
}

describe('terminal workspace sweep', () => {
  function harness(terminal: Issue[]) {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue(terminal),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
    }
    const workspaceManager = stubWorkspaceManager()
    const orch = new SymphonyOrchestrator({
      tracker: tracker as any,
      agentRunner: { run: vi.fn() } as any,
      workspaceManager: workspaceManager as any,
    })
    return { tracker, workspaceManager, orch }
  }

  it('removes the clone of an issue that reached a terminal state', async () => {
    const { tracker, workspaceManager, orch } = harness([
      makeIssue({ id: 'done-1', identifier: 'TICKET-1', state: 'Done' }),
    ])
    await (orch as any).sweepTerminalWorkspaces()
    expect(workspaceManager.removeForIssue).toHaveBeenCalledWith('TICKET-1')
    expect(tracker.fetchIssuesByStates).toHaveBeenCalled()
  })

  it('sweeps on every tick, not only at start-up', async () => {
    // Terminal is a human decision that nothing notifies us about, so a sweep
    // that only ran at start-up meant a long-lived orchestrator never
    // reclaimed anything: clones piled up until someone restarted the process.
    const { workspaceManager, orch } = harness([
      makeIssue({ id: 'done-1', identifier: 'TICKET-1', state: 'Done' }),
    ])
    await (orch as any).tick()
    await (orch as any).tick()
    expect(workspaceManager.removeForIssue).toHaveBeenCalledTimes(2)
  })

  it('leaves the clone of a still-running issue alone', async () => {
    // Deleting a workspace out from under a live agent destroys uncommitted
    // work mid-run. reconcileTrackerStates terminates these first and cleans
    // up as it goes; whatever is still in `running` here is in flight.
    const { workspaceManager, orch } = harness([
      makeIssue({ id: 'run-1', identifier: 'TICKET-1', state: 'Done' }),
    ])
    orch.state.running.set('run-1', runningEntry('run-1', 'TICKET-1'))
    await (orch as any).sweepTerminalWorkspaces()
    expect(workspaceManager.removeForIssue).not.toHaveBeenCalled()
  })

  it('survives a tracker that throws', async () => {
    const { workspaceManager, orch } = harness([])
    ;(orch as any).tracker.fetchIssuesByStates = vi.fn().mockRejectedValue(new Error('gitlab 503'))
    await expect((orch as any).sweepTerminalWorkspaces()).resolves.toBeUndefined()
    expect(workspaceManager.removeForIssue).not.toHaveBeenCalled()
  })
})

describe('stall detection uses reported activity', () => {
  function orchWithRun(stallTimeoutMs: number) {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
    }
    const orch = new SymphonyOrchestrator({
      tracker: tracker as any, agentRunner: { run: vi.fn() } as any, stallTimeoutMs,
    })
    orch.state.running.set('run-1', runningEntry('run-1', 'TICKET-1'))
    orch.state.claimed.add('run-1')
    return orch
  }

  it('spares a long run that is still reporting activity', async () => {
    // The defect this exists for: lastAgentTimestamp was never written, so the
    // reference was always startedAt and ANY run outliving stall_timeout_ms was
    // killed — however much progress it was making. Five minutes by default,
    // against a task that clones a repository.
    const orch = orchWithRun(1000)
    const entry = orch.state.running.get('run-1')!
    entry.startedAt = new Date(Date.now() - 600000)
    orch.recordAgentActivity({ issueId: 'run-1', sessionId: 's1', event: 'tool.executed', at: new Date() })
    ;(orch as any).reconcileStalledRuns()
    expect(orch.state.running.has('run-1')).toBe(true)
  })

  it('still kills a run that has gone silent for longer than the timeout', async () => {
    const orch = orchWithRun(1000)
    const entry = orch.state.running.get('run-1')!
    entry.startedAt = new Date(Date.now() - 600000)
    orch.recordAgentActivity({
      issueId: 'run-1', sessionId: 's1', event: 'tool.executed',
      at: new Date(Date.now() - 300000),
    })
    ;(orch as any).reconcileStalledRuns()
    expect(orch.state.running.has('run-1')).toBe(false)
  })

  it('falls back to the start time when no activity was ever reported', async () => {
    // The event stream may be unavailable. A coarse timeout beats none.
    const orch = orchWithRun(1000)
    orch.state.running.get('run-1')!.startedAt = new Date(Date.now() - 600000)
    ;(orch as any).reconcileStalledRuns()
    expect(orch.state.running.has('run-1')).toBe(false)
  })

  it('records the session id so logs can be tied to a session', async () => {
    const orch = orchWithRun(1000)
    orch.recordAgentActivity({ issueId: 'run-1', sessionId: 'sess-42', event: 'session_created', at: new Date() })
    const entry = orch.state.running.get('run-1')!
    expect(entry.sessionId).toBe('sess-42')
    expect(entry.lastAgentEvent).toBe('session_created')
  })

  it('ignores activity for an issue that is no longer running', () => {
    const orch = orchWithRun(1000)
    expect(() => orch.recordAgentActivity({
      issueId: 'gone', sessionId: 's1', event: null, at: new Date(),
    })).not.toThrow()
  })
})

describe('terminateRunningIssue honours its cleanup flag', () => {
  function orchWith(currentState: string) {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([
        makeIssue({ id: 'run-1', identifier: 'TICKET-1', state: currentState }),
      ]),
    }
    const workspaceManager = stubWorkspaceManager()
    const orch = new SymphonyOrchestrator({
      tracker: tracker as any, agentRunner: { run: vi.fn() } as any,
      workspaceManager: workspaceManager as any,
    })
    orch.state.running.set('run-1', runningEntry('run-1', 'TICKET-1'))
    orch.state.claimed.add('run-1')
    return { orch, workspaceManager }
  }

  it('removes the workspace when the issue reached a terminal state', async () => {
    // The item is done: nothing will be retried into this clone, so keeping it
    // is pure accumulation. The flag was accepted and then ignored before.
    const { orch, workspaceManager } = orchWith('Done')
    await orch.reconcileTrackerStates()
    expect(workspaceManager.removeForIssue).toHaveBeenCalledWith('TICKET-1')
  })

  it('keeps the workspace when the issue merely left the active set', async () => {
    // Not terminal: a human may put it back, and a retry resumes in the same
    // workspace. Deleting it would throw away the agent's uncommitted work.
    const { orch, workspaceManager } = orchWith('In Review')
    await orch.reconcileTrackerStates()
    expect(orch.state.running.has('run-1')).toBe(false)
    expect(workspaceManager.removeForIssue).not.toHaveBeenCalled()
  })

  it('keeps the workspace when a run is killed as stalled', async () => {
    const { orch, workspaceManager } = orchWith('In Progress')
    orch.state.running.get('run-1')!.startedAt = new Date(Date.now() - 600000)
    ;(orch as any).stallTimeoutMs = 1000
    ;(orch as any).reconcileStalledRuns()
    expect(orch.state.running.has('run-1')).toBe(false)
    expect(workspaceManager.removeForIssue).not.toHaveBeenCalled()
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
    const stateDuringRun: string[] = []
    const agentRunner = {
      run: vi.fn(async (issue: Issue, prompt: string) => {
        seen.push({ issueId: issue.id, prompt })
        const [live] = await tracker.fetchIssueStatesByIds([issue.id])
        stateDuringRun.push(live!.state)
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

    // Todo -> In Progress is written back through the tracker before the run
    // starts, so it has to be observed from inside the run — by the time the
    // worker exits the item has already moved on again.
    expect(stateDuringRun).toEqual(['In Progress'])

    // A clean exit clears the claim and marks the issue completed.
    expect(orch.state.running.has('q-1')).toBe(false)
    expect(orch.state.claimed.has('q-1')).toBe(false)
    expect(orch.state.completed.has('q-1')).toBe(true)

    // ...and — the part that has to survive a restart — the item is moved out
    // of In Progress on the tracker. Leaving it there means the next start
    // re-dispatches work that already ran.
    const [afterExit] = await tracker.fetchIssueStatesByIds(['q-1'])
    expect(afterExit!.state).toBe('In Review')
  })

  it('records Failed on the tracker when the agent runner fails', async () => {
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-3', identifier: 'SYM-003', state: 'Todo' }))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0 })) }
    const orch = new SymphonyOrchestrator({ tracker, agentRunner: agentRunner as any, promptTemplate: '' })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(orch.state.completed.has('q-3')).toBe(false)
    const [afterExit] = await tracker.fetchIssueStatesByIds(['q-3'])
    expect(afterExit!.state).toBe('Failed')

    // The durable record owns the retry now, so there must be no second,
    // in-memory schedule racing it with its own attempt counter.
    expect(orch.state.retryAttempts.has('q-3')).toBe(false)
    expect(orch.state.claimed.has('q-3')).toBe(false)
  })

  it('falls back to an in-memory retry when the tracker rejects the Failed transition', async () => {
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-4', identifier: 'SYM-004', state: 'Todo' }))
    const realUpdate = tracker.updateIssueState.bind(tracker)
    vi.spyOn(tracker, 'updateIssueState').mockImplementation(async (id, state) => {
      if (state === 'Failed') throw new Error('queue root went read-only')
      return realUpdate(id, state)
    })

    const agentRunner = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0 })) }
    const orch = new SymphonyOrchestrator({ tracker, agentRunner: agentRunner as any, promptTemplate: '' })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    const retry = orch.state.retryAttempts.get('q-4')
    expect(retry?.attempt).toBe(1)
    expect(retry?.dueAtMs).toBeGreaterThan(Date.now())
    expect(orch.state.claimed.has('q-4')).toBe(true)
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
