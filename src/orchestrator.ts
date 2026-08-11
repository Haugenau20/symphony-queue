import { getLogger } from './log.js'
import type { OrchestratorState, Issue } from './models.js'
import { createOrchestratorState } from './models.js'
import type { TrackerAdapter } from './tracker/base.js'
import type { AgentRunner, AgentActivity, AgentRunResult } from './agent_runner.js'
import { IMPLEMENTATION_PERMISSIONS } from './agent_runner.js'
import type { WorkspaceManager } from './workspace.js'
import { renderPrompt } from './prompt_builder.js'

/**
 * Where a run lands when the agent's turns finish normally. `In Review` is the
 * human gate (docs/DESIGN.md §1) — the orchestrator never decides that work is
 * done, only that the agent stopped. A human moves it on to done/ or back to
 * todo/.
 */
export const EXIT_STATE_NORMAL = 'In Review'

/**
 * Where a run lands on abnormal exit. `Failed` is a holding pen with a timer,
 * not a terminal state: the tracker stamps attempts/next_retry_at and its sweep
 * returns the item to todo/ when due (docs/DESIGN.md §4).
 */
export const EXIT_STATE_ABNORMAL = 'Failed'

/**
 * The terminal states a run's `shouldContinue` check treats as "stop". This is
 * the list AgentRunner's now-removed `isActiveState` used to hard-code
 * in-module; it moves here with dispatchIssue, which now owns the liveness
 * check the runner used to make on its behalf. Deliberately its own list
 * rather than a reuse of `terminalStates` above (the configurable, exact-case
 * list `reconcileTrackerStates` compares against) — that field can be
 * reconfigured per-workflow, and swapping it in here would change today's
 * dispatch behaviour instead of preserving it.
 */
const TERMINAL = ['closed', 'cancelled', 'canceled', 'duplicate', 'done']

export function dispatchKey(issue: Issue): [number, number, string] {
  const prio = issue.priority ?? 9999
  const created = issue.createdAt?.getTime() ?? 0
  return [prio, created, issue.identifier]
}

export function shouldDispatch(
  issue: Issue, state: OrchestratorState,
  activeStates: string[] = ['Todo', 'In Progress'],
  terminalStates: string[] = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
): boolean {
  if (state.running.has(issue.id)) return false
  if (state.claimed.has(issue.id)) return false
  if (state.completed.has(issue.id)) return false
  if (!activeStates.includes(issue.state)) return false
  if (terminalStates.includes(issue.state)) return false
  if (issue.state.toLowerCase() === 'todo') {
    for (const blocker of issue.blockedBy ?? []) {
      if (blocker.state && !terminalStates.includes(blocker.state)) return false
    }
  }
  return true
}

export function availableSlots(state: OrchestratorState): number {
  return Math.max(state.maxConcurrentAgents - state.running.size, 0)
}

export function availableSlotsForState(state: OrchestratorState, issueState: string): number {
  const key = issueState.toLowerCase()
  const perStateLimit = state.maxConcurrentAgentsByState[key]
  if (perStateLimit !== undefined) {
    const runningInState = Array.from(state.running.values()).filter((e) => e.issue.state.toLowerCase() === key).length
    return Math.max(perStateLimit - runningInState, 0)
  }
  return availableSlots(state)
}

export function backoffDelay(attempt: number, maxBackoffMs: number = 300000): number {
  if (attempt <= 0) attempt = 1
  return Math.min(10000 * Math.pow(2, attempt - 1), maxBackoffMs)
}

export interface OrchestratorConfig {
  tracker: TrackerAdapter
  agentRunner: AgentRunner
  workspaceManager?: WorkspaceManager
  promptTemplate?: string
  maxConcurrent?: number
  pollIntervalMs?: number
  activeStates?: string[]
  terminalStates?: string[]
  maxTurns?: number
  maxRetryBackoffMs?: number
  stallTimeoutMs?: number
  maxConcurrentByState?: Record<string, number>
}

export class SymphonyOrchestrator {
  state: OrchestratorState
  private tracker: TrackerAdapter
  private agentRunner: AgentRunner
  private workspaceManager?: WorkspaceManager
  private promptTemplate?: string
  private activeStates: string[]
  private terminalStates: string[]
  private maxTurns: number
  private maxRetryBackoffMs: number
  private stallTimeoutMs: number
  private tickInterval: number
  private running = true
  private observers: Array<(state: OrchestratorState) => void> = []

  constructor(config: OrchestratorConfig) {
    this.state = createOrchestratorState({
      maxConcurrentAgents: config.maxConcurrent ?? 10,
      pollIntervalMs: config.pollIntervalMs ?? 30000,
      maxConcurrentAgentsByState: config.maxConcurrentByState ?? {},
    })
    this.tracker = config.tracker
    this.agentRunner = config.agentRunner
    this.workspaceManager = config.workspaceManager
    this.promptTemplate = config.promptTemplate
    this.activeStates = config.activeStates ?? ['Todo', 'In Progress']
    this.terminalStates = config.terminalStates ?? ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']
    this.maxTurns = config.maxTurns ?? 20
    this.maxRetryBackoffMs = config.maxRetryBackoffMs ?? 300000
    this.stallTimeoutMs = config.stallTimeoutMs ?? 300000
    this.tickInterval = (config.pollIntervalMs ?? 30000) / 1000
  }

  async run(): Promise<void> {
    getLogger().info('orchestrator_started')
    await this.tick()
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, this.tickInterval * 1000))
      if (!this.running) break
      await this.tick()
    }
    getLogger().info('orchestrator_stopped')
  }

  stop(): void { this.running = false }

  stopIssue(issueId: string): boolean {
    const entry = this.state.running.get(issueId)
    if (!entry) return false
    if (entry.cancel) entry.cancel()
    this.state.running.delete(issueId)
    this.state.claimed.delete(issueId)
    if (entry.startedAt) this.state.agentTotals.secondsRunning += (Date.now() - entry.startedAt.getTime()) / 1000
    this.state.agentTotals.totalTokens += entry.totalTokens
    this.state.agentTotals.inputTokens += entry.inputTokens
    this.state.agentTotals.outputTokens += entry.outputTokens
    getLogger().info({ issueId, identifier: entry.identifier }, 'issue_stopped_by_user')
    this.notifyObservers()
    return true
  }

  private async tick(): Promise<void> {
    this.state = await this.reconcileRunning()
    await this.sweepTerminalWorkspaces()
    let issues: Issue[] = []
    try {
      issues = await this.tracker.fetchCandidateIssues()
    } catch (err) {
      getLogger().error({ error: String(err) }, 'candidate_fetch_failed')
      this.notifyObservers()
      return
    }
    for (const issue of issues.sort((a, b) => {
      const [pa, ca, ia] = dispatchKey(a); const [pb, cb, ib] = dispatchKey(b)
      if (pa !== pb) return pa - pb
      if (ca !== cb) return ca - cb
      return ia.localeCompare(ib)
    })) {
      if (availableSlots(this.state) <= 0) break
      if (availableSlotsForState(this.state, issue.state) <= 0) continue
      if (shouldDispatch(issue, this.state, this.activeStates, this.terminalStates)) {
        this.dispatchIssue(issue)
      }
    }
    this.notifyObservers()
  }

  private async reconcileRunning(): Promise<OrchestratorState> {
    this.state = this.reconcileStalledRuns()
    this.processRetries()
    this.state = await this.reconcileTrackerStates()
    return this.state
  }

  private processRetries(): void {
    const now = Date.now()
    const toRelease: string[] = []
    for (const [issueId, retry] of this.state.retryAttempts) {
      if (now >= retry.dueAtMs) {
        toRelease.push(issueId)
      }
    }
    for (const issueId of toRelease) {
      this.state.claimed.delete(issueId)
      this.state.retryAttempts.delete(issueId)
    }
  }

  async reconcileTrackerStates(): Promise<OrchestratorState> {
    const runningIds = Array.from(this.state.running.keys())
    if (runningIds.length === 0) return this.state

    try {
      const currentIssues = await this.tracker.fetchIssueStatesByIds(runningIds)
      const currentMap = new Map(currentIssues.map((i) => [i.id, i]))

      for (const [issueId, entry] of this.state.running) {
        const current = currentMap.get(issueId)
        if (!current) continue

        const currentState = current.state
        if (this.terminalStates.includes(currentState)) {
          getLogger().warn({ issueId, identifier: entry.identifier, state: currentState }, 'terminating_terminal_issue')
          if (entry.cancel) entry.cancel()
          this.state = this.terminateRunningIssue(issueId, true)
          this.state.completed.add(issueId)
        } else if (!this.activeStates.includes(currentState)) {
          getLogger().warn({ issueId, identifier: entry.identifier, state: currentState }, 'terminating_non_active_issue')
          if (entry.cancel) entry.cancel()
          this.state = this.terminateRunningIssue(issueId, false)
        } else {
          const updatedEntry = { ...entry, issue: current }
          this.state.running.set(issueId, updatedEntry as any)
        }
      }
    } catch (err) {
      getLogger().error({ error: String(err) }, 'state_reconciliation_failed')
    }

    return this.state
  }

  /**
   * Stamp a running entry with the moment its agent last showed a sign of life.
   *
   * This is the input `reconcileStalledRuns` was always missing.
   * `lastAgentTimestamp` was set to null at dispatch and nothing ever wrote to
   * it, so the `?? entry.startedAt` fallback below always applied and
   * `stall_timeout_ms` measured how long a run had been ALIVE rather than how
   * long it had been SILENT — killing any run that outlived the timeout however
   * much progress it was making.
   */
  recordAgentActivity(activity: AgentActivity): void {
    const entry = this.state.running.get(activity.issueId)
    if (!entry) return
    entry.lastAgentTimestamp = activity.at
    entry.lastAgentEvent = activity.event
    entry.sessionId = activity.sessionId
  }

  private reconcileStalledRuns(): OrchestratorState {
    if (this.stallTimeoutMs <= 0) return this.state
    const now = new Date()
    const toRemove: string[] = []
    for (const [issueId, entry] of this.state.running) {
      const reference = entry.lastAgentTimestamp ?? entry.startedAt
      if (!reference) continue
      const idleMs = now.getTime() - reference.getTime()
      if (idleMs > this.stallTimeoutMs) {
        getLogger().warn({
          issueId, identifier: entry.identifier, idleMs, lastEvent: entry.lastAgentEvent,
          // Separates "the agent went quiet" from "we never saw it at all",
          // which normally means the event stream never connected and the
          // timeout has silently gone back to being a run timeout.
          sawActivity: entry.lastAgentTimestamp !== null,
        }, 'stall_detected')
        if (entry.cancel) entry.cancel()
        toRemove.push(issueId)
      }
    }
    for (const issueId of toRemove) {
      this.state = this.terminateRunningIssue(issueId, false)
      this.state.retryAttempts.set(issueId, { issueId, identifier: 'unknown', attempt: 1, dueAtMs: Date.now() + 1000, error: 'stall_timeout' })
      this.state.claimed.add(issueId)
    }
    return this.state
  }

  private terminateRunningIssue(issueId: string, cleanupWorkspace: boolean): OrchestratorState {
    const entry = this.state.running.get(issueId)
    this.state.running.delete(issueId)
    this.state.claimed.delete(issueId)
    if (entry) {
      if (entry.startedAt) this.state.agentTotals.secondsRunning += (Date.now() - entry.startedAt.getTime()) / 1000
      this.state.agentTotals.totalTokens += entry.totalTokens
      this.state.agentTotals.inputTokens += entry.inputTokens
      this.state.agentTotals.outputTokens += entry.outputTokens
      // The caller decides: a run cancelled because its issue reached a
      // terminal state is finished with its clone, while one cancelled for a
      // stall or a state we do not recognise may still be retried into the same
      // workspace and must keep it.
      if (cleanupWorkspace) this.removeWorkspace(entry.identifier)
    }
    return this.state
  }

  private removeWorkspace(identifier: string): void {
    try {
      this.workspaceManager?.removeForIssue(identifier)
    } catch (err) {
      getLogger().warn({ identifier, error: String(err) }, 'workspace_removal_failed')
    }
  }

  /**
   * Delete the clones of items that have reached a terminal state.
   *
   * Runs every tick, not only at start-up. Terminal is a human decision — a
   * label moved to `symphony::done`, a file dragged into `done/` — and nothing
   * notifies us of it, so polling is the only way to hear about it. Sweeping
   * only at start-up meant a long-lived orchestrator never reclaimed anything:
   * clones piled up until someone restarted the process.
   *
   * Costs one extra issue listing per poll, the same call `fetchCandidateIssues`
   * already makes. That is the price of not needing a restart to free disk.
   */
  private async sweepTerminalWorkspaces(): Promise<void> {
    if (!this.workspaceManager) return
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.terminalStates)
      for (const ti of terminalIssues) {
        // Never pull the floor out from under a live run. reconcileTrackerStates
        // runs first and terminates these, cleaning up as it goes; anything
        // still in `running` here is mid-flight and its clone is in use.
        if (this.state.running.has(ti.id)) continue
        this.removeWorkspace(ti.identifier)
      }
    } catch (err) {
      getLogger().warn({ error: String(err) }, 'workspace_sweep_failed')
    }
  }

  private dispatchIssue(issue: Issue, attempt?: number | null): void {
    const abortController = new AbortController()
    const task = (async () => {
      try {
        if (issue.state === 'Todo') {
          try {
            await this.tracker.updateIssueState(issue.id, 'In Progress')
            getLogger().info({ issueId: issue.id, identifier: issue.identifier }, 'state_transitioned_to_in_progress')
          } catch (stateErr) {
            getLogger().warn({ issueId: issue.id, identifier: issue.identifier, error: String(stateErr) }, 'state_transition_failed')
          }
        }
        const ws = this.workspaceManager?.createForIssue(issue.identifier)
        if (ws && this.workspaceManager) {
          await this.workspaceManager.runAfterCreate(ws)
          await this.workspaceManager.runBeforeRun(ws)
        }
        const prompt = renderPrompt(this.promptTemplate ?? '', issue, attempt ?? 0, {
          workspace: ws ? { path: ws.path, key: ws.workspaceKey } : null,
        }) + (ws ? `\n\n## Workspace\n\nYour workspace is at \`${ws.path}\`. All work must be done inside this directory.` : '')
        // The signal was created here and passed to nothing, so `cancel()` —
        // the stall detector's only lever — aborted an AbortController nobody
        // listened to. The run it "killed" carried on, evicted from `running`
        // but still holding the workspace and still talking to the model.
        let result: AgentRunResult
        try {
          result = await this.agentRunner.run(issue, prompt, ws?.path ?? null, abortController.signal, {
            permissions: IMPLEMENTATION_PERMISSIONS,
            // Mirrors what the runner used to do internally via
            // issueStateFetcher + isActiveState: a fetch failure must behave
            // exactly as it did before, i.e. as "stop" — refreshIssueState's
            // catch block returned null on error, which read as inactive.
            shouldContinue: async () => {
              try {
                const [fresh] = await this.tracker.fetchIssueStatesByIds([issue.id])
                return fresh !== undefined && !TERMINAL.includes(fresh.state.toLowerCase())
              } catch {
                return false
              }
            },
          })
        } finally {
          // after_run is paired with the agent invocation, not with a
          // successful result. Cleanup and publication hooks still need to run
          // when the runner throws or returns an abnormal outcome. The hook is
          // advisory: a broken implementation must not replace the agent's
          // actual result with a hook failure.
          if (ws && this.workspaceManager) {
            try {
              await this.workspaceManager.runAfterRun(ws)
            } catch (hookErr) {
              getLogger().warn({
                issueId: issue.id, identifier: issue.identifier, error: String(hookErr),
              }, 'after_run_hook_failed')
            }
          }
        }
        await this.onWorkerExit(issue.id, result.success, result)
      } catch (err) {
        getLogger().error({ issueId: issue.id, error: String(err) }, 'worker_failed')
        await this.onWorkerExit(issue.id, false)
      }
    })()
    this.state.running.set(issue.id, {
      session: null,
      issueId: issue.id, identifier: issue.identifier, issue,
      sessionId: null, lastAgentEvent: null, lastAgentTimestamp: null, lastAgentMessage: '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      lastReportedInputTokens: 0, lastReportedOutputTokens: 0, lastReportedTotalTokens: 0,
      retryAttempt: attempt ?? 0, startedAt: new Date(), task, cancel: () => abortController.abort(),
    })
    this.state.claimed.add(issue.id)
    this.state.retryAttempts.delete(issue.id)
    getLogger().info({ issueId: issue.id, identifier: issue.identifier, state: issue.state }, 'dispatched')
  }

  private async onWorkerExit(
    issueId: string, normal: boolean, result?: AgentRunResult,
  ): Promise<void> {
    const entry = this.state.running.get(issueId)
    if (!entry) return
    this.state.running.delete(issueId)
    this.state.claimed.delete(issueId)
    if (entry.startedAt) this.state.agentTotals.secondsRunning += (Date.now() - entry.startedAt.getTime()) / 1000
    this.state.agentTotals.totalTokens += entry.totalTokens
    this.state.agentTotals.inputTokens += entry.inputTokens
    this.state.agentTotals.outputTokens += entry.outputTokens

    // Record the outcome on the tracker, not just in memory. `completed` and
    // `retryAttempts` die with the process; the item on disk is what survives.
    // Without this the run terminates but the item never leaves in-progress/,
    // so the next start re-dispatches work that already ran (SPEC §7.2).
    const targetState = normal ? EXIT_STATE_NORMAL : EXIT_STATE_ABNORMAL
    let recorded = false
    try {
      await this.tracker.updateIssueState(issueId, targetState)
      recorded = true
      getLogger().info({ issueId, identifier: entry.identifier, state: targetState }, 'state_transitioned_on_exit')
    } catch (stateErr) {
      getLogger().warn({ issueId, identifier: entry.identifier, state: targetState, error: String(stateErr) }, 'exit_state_transition_failed')
    }

    // Exhausting the turn budget lands on the same state as finishing, so the
    // board cannot tell "the agent said it was done" from "we ran out of
    // road". Only `stopReason` distinguishes them, and it lives in a container
    // log nobody triaging a queue is reading. Say it where the work is.
    if (result?.stopReason === 'max_turns') {
      await this.annotate(issueId, entry.identifier,
        `**Symphony: this run ended by exhausting its turn budget**, not because the agent `
        + `reported it was finished (\`stopReason: max_turns\`, ${result.turnsCompleted} turns used).\n\n`
        + 'Whatever is here may be partial — the agent was still being asked to continue when '
        + 'the budget ran out. Review before treating it as complete.')
    }

    if (normal) {
      this.state.completed.add(issueId)
    } else if (!recorded) {
      // Tracker rejected the transition, so nothing durable owns the retry.
      // Fall back to the in-memory schedule so the item is not simply dropped.
      const nextAttempt = entry.retryAttempt + 1
      this.state.retryAttempts.set(issueId, { issueId, identifier: entry.identifier, attempt: nextAttempt, dueAtMs: Date.now() + backoffDelay(nextAttempt, this.maxRetryBackoffMs), error: 'worker_exit_abnormal' })
      this.state.claimed.add(issueId)
    }
    this.notifyObservers()
  }

  /**
   * Commentary, never load-bearing: a tracker that cannot take notes, or one
   * whose instance rejects this call, must not turn a finished run into a
   * failed one. Swallow and log.
   */
  private async annotate(issueId: string, identifier: string, note: string): Promise<void> {
    if (!this.tracker.annotateIssue) return
    try {
      await this.tracker.annotateIssue(issueId, note)
    } catch (err) {
      getLogger().warn({ issueId, identifier, error: String(err) }, 'issue_annotation_failed')
    }
  }

  addObserver(callback: (state: OrchestratorState) => void): void { this.observers.push(callback) }

  private notifyObservers(): void {
    for (const cb of this.observers) {
      try { cb(this.state) } catch (err) { getLogger().warn({ error: String(err) }, 'observer_error') }
    }
  }
}
