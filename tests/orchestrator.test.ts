import { describe, it, expect, vi } from 'vitest'
import { shouldDispatch, dispatchKey, availableSlots, backoffDelay, SymphonyOrchestrator } from '../src/orchestrator.js'
import { createOrchestratorState } from '../src/models.js'
import { MemoryTracker } from '../src/tracker/memory.js'
import { IMPLEMENTATION_PERMISSIONS } from '../src/agent_runner.js'
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

describe('dispatchIssue shouldContinue', () => {
  // AgentRunner no longer fetches issue state itself; dispatchIssue now
  // supplies that as a shouldContinue predicate. These pin down that it
  // reproduces refreshIssueState + isActiveState's semantics exactly,
  // including the two "stop" paths that used to be implicit in a caught
  // exception: no issue found, and the fetch itself failing.
  function harness(fetchIssueStatesByIds: (ids: string[]) => Promise<Issue[]>) {
    const tracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      updateIssueState: vi.fn(async () => {}),
      fetchIssueStatesByIds: vi.fn(fetchIssueStatesByIds),
    }
    const agentRunner = { run: vi.fn().mockResolvedValue({ success: true, sessionId: 's', turnsCompleted: 1 }) }
    const orch = new SymphonyOrchestrator({ tracker: tracker as any, agentRunner: agentRunner as any })
    return { tracker, agentRunner, orch }
  }

  async function capturedShouldContinue(orch: any, agentRunner: { run: ReturnType<typeof vi.fn> }, issue: Issue) {
    ;(orch as any).dispatchIssue(issue)
    await Promise.all(Array.from((orch as any).state.running.values()).map((e: any) => e.task))
    return agentRunner.run.mock.calls[0][4].shouldContinue as () => Promise<boolean>
  }

  it('continues while the tracker still reports the issue active', async () => {
    const { agentRunner, orch } = harness(async () => [makeIssue({ id: 'q-1', state: 'In Progress' })])
    const shouldContinue = await capturedShouldContinue(orch, agentRunner, makeIssue({ id: 'q-1', state: 'In Progress' }))
    expect(await shouldContinue()).toBe(true)
  })

  it('stops when the tracker reports a terminal state', async () => {
    const { agentRunner, orch } = harness(async () => [makeIssue({ id: 'q-1', state: 'Done' })])
    const shouldContinue = await capturedShouldContinue(orch, agentRunner, makeIssue({ id: 'q-1', state: 'In Progress' }))
    expect(await shouldContinue()).toBe(false)
  })

  it('stops when the issue is no longer found at all', async () => {
    // Mirrors refreshIssueState's `issues[0] ?? null` — an empty result reads
    // as "stop", the same as a fetch error.
    const { agentRunner, orch } = harness(async () => [])
    const shouldContinue = await capturedShouldContinue(orch, agentRunner, makeIssue({ id: 'q-1', state: 'In Progress' }))
    expect(await shouldContinue()).toBe(false)
  })

  it('stops, not throws, when the fetch itself fails', async () => {
    // refreshIssueState's catch block returned null on error, and the loop
    // read that as inactive. A fetch failure here must behave identically:
    // shouldContinue resolves false rather than rejecting.
    const { agentRunner, orch } = harness(async () => { throw new Error('tracker unreachable') })
    const shouldContinue = await capturedShouldContinue(orch, agentRunner, makeIssue({ id: 'q-1', state: 'In Progress' }))
    await expect(shouldContinue()).resolves.toBe(false)
  })
})

describe('dispatch hands the workspace to the runner', () => {
  it('passes the workspace path so the session is rooted there', async () => {
    // Without this the agent's session roots at the server default while its
    // prompt talks about a directory somewhere else entirely.
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-1', identifier: 'SYM-001', state: 'Todo' }))
    const agentRunner = { run: vi.fn().mockResolvedValue({ success: true, sessionId: 's', turnsCompleted: 1 }) }
    const workspaceManager = stubWorkspaceManager()
    workspaceManager.createForIssue.mockReturnValue({ path: '/workspaces/SYM-001', workspaceKey: 'SYM-001', createdNow: true })

    const orch = new SymphonyOrchestrator({
      tracker: tracker as any, agentRunner: agentRunner as any,
      workspaceManager: workspaceManager as any, promptTemplate: 'go',
    })
    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(agentRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q-1' }), expect.any(String), '/workspaces/SYM-001',
      expect.any(AbortSignal),
      // dispatchIssue passes the implementation pipeline's permission set
      // explicitly now, plus a shouldContinue predicate the runner calls
      // instead of fetching issue state itself.
      { permissions: IMPLEMENTATION_PERMISSIONS, shouldContinue: expect.any(Function) },
    )
    expect(workspaceManager.runAfterRun).toHaveBeenCalledTimes(1)
    expect(workspaceManager.runAfterRun).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspaces/SYM-001' }),
    )
    expect(agentRunner.run.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceManager.runAfterRun.mock.invocationCallOrder[0]!,
    )
  })

  it('runs after_run when the agent runner throws', async () => {
    const tracker = new MemoryTracker(['Todo', 'In Progress'])
    tracker.addIssue(makeIssue({ id: 'q-2', identifier: 'SYM-002', state: 'Todo' }))
    const agentRunner = { run: vi.fn().mockRejectedValue(new Error('runner crashed')) }
    const workspaceManager = stubWorkspaceManager()
    workspaceManager.createForIssue.mockReturnValue({
      path: '/workspaces/SYM-002', workspaceKey: 'SYM-002', createdNow: false,
    })

    const orch = new SymphonyOrchestrator({
      tracker, agentRunner: agentRunner as any,
      workspaceManager: workspaceManager as any, promptTemplate: 'go',
    })
    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(workspaceManager.runAfterRun).toHaveBeenCalledTimes(1)
    expect(workspaceManager.runAfterRun).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspaces/SYM-002' }),
    )
    const [afterExit] = await tracker.fetchIssueStatesByIds(['q-2'])
    expect(afterExit!.state).toBe('Failed')
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

describe('exit annotation', () => {
  // Exhausting the turn budget lands on the same state as finishing cleanly,
  // so the board cannot tell them apart. `stopReason` is the only thing that
  // can, and it lives in a container log nobody triaging a queue reads.
  function harness(annotateIssue?: (id: string, note: string) => Promise<void>) {
    const tracker: Record<string, unknown> = { updateIssueState: vi.fn(async () => {}) }
    if (annotateIssue) tracker.annotateIssue = vi.fn(annotateIssue)
    const orch = new SymphonyOrchestrator({
      tracker: tracker as any, agentRunner: { run: vi.fn() } as any,
    })
    ;(orch as any).state.running.set('issue-5', {
      issueId: 'issue-5', identifier: 'TICKET-5', startedAt: new Date(),
      totalTokens: 0, inputTokens: 0, outputTokens: 0, retryAttempt: 0,
    })
    return { tracker, orch }
  }

  const exit = (orch: any, result: unknown) =>
    orch.onWorkerExit('issue-5', true, result)

  it('annotates a run that ran out of turns', async () => {
    const { tracker, orch } = harness(async () => {})
    await exit(orch, { success: true, turnsCompleted: 10, stopReason: 'max_turns' })

    const note = (tracker.annotateIssue as any).mock.calls[0][1] as string
    expect(note).toContain('max_turns')
    expect(note).toContain('10 turns')
  })

  it('says nothing about a run that reported itself complete', async () => {
    const { tracker, orch } = harness(async () => {})
    await exit(orch, { success: true, turnsCompleted: 1, stopReason: 'completed' })
    expect(tracker.annotateIssue).not.toHaveBeenCalled()
  })

  it('says nothing when the run was cut short by the issue leaving its states', async () => {
    const { tracker, orch } = harness(async () => {})
    await exit(orch, { success: true, turnsCompleted: 2, stopReason: 'issue_inactive' })
    expect(tracker.annotateIssue).not.toHaveBeenCalled()
  })

  it('still transitions the state on a tracker that cannot take notes', async () => {
    // The file queue has no annotateIssue at all; the exit path must not
    // assume one exists.
    const { tracker, orch } = harness()
    await expect(exit(orch, { success: true, turnsCompleted: 10, stopReason: 'max_turns' }))
      .resolves.toBeUndefined()
    expect(tracker.updateIssueState).toHaveBeenCalledWith('issue-5', 'In Review')
  })

  it('treats a failed note as commentary, not as a failed run', async () => {
    // Annotation is the last thing to happen and the least important. A
    // GitLab instance that rejects the note must not turn a finished run into
    // one that looks abnormal.
    const { tracker, orch } = harness(async () => { throw new Error('403 Forbidden') })
    await expect(exit(orch, { success: true, turnsCompleted: 10, stopReason: 'max_turns' }))
      .resolves.toBeUndefined()
    expect(tracker.updateIssueState).toHaveBeenCalledWith('issue-5', 'In Review')
    expect((orch as any).state.completed.has('issue-5')).toBe(true)
  })

  it('does not annotate when there is no run result at all', async () => {
    // The crash path calls onWorkerExit with no result; there is no stopReason
    // to report and the state already says Failed.
    const { tracker, orch } = harness(async () => {})
    await (orch as any).onWorkerExit('issue-5', false)
    expect(tracker.annotateIssue).not.toHaveBeenCalled()
  })
})
