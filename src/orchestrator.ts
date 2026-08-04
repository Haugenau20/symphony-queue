import { getLogger } from './log.js'
import type { OrchestratorState, Issue } from './models.js'
import { createOrchestratorState } from './models.js'
import type { TrackerAdapter } from './tracker/base.js'
import type { AgentRunner } from './agent_runner.js'
import type { WorkspaceManager } from './workspace.js'
import { renderPrompt } from './prompt_builder.js'

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
    await this.startupCleanup()
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

  private reconcileStalledRuns(): OrchestratorState {
    if (this.stallTimeoutMs <= 0) return this.state
    const now = new Date()
    const toRemove: string[] = []
    for (const [issueId, entry] of this.state.running) {
      const reference = entry.lastAgentTimestamp ?? entry.startedAt
      if (!reference) continue
      if (now.getTime() - reference.getTime() > this.stallTimeoutMs) {
        getLogger().warn({ issueId, identifier: entry.identifier }, 'stall_detected')
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
    }
    return this.state
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.terminalStates)
      for (const ti of terminalIssues) this.workspaceManager?.removeForIssue(ti.identifier)
    } catch (err) {
      getLogger().warn({ error: String(err) }, 'startup_cleanup_failed')
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
        const result = await this.agentRunner.run(issue, prompt)
        this.onWorkerExit(issue.id, result.success)
      } catch (err) {
        getLogger().error({ issueId: issue.id, error: String(err) }, 'worker_failed')
        this.onWorkerExit(issue.id, false)
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

  private onWorkerExit(issueId: string, normal: boolean): void {
    const entry = this.state.running.get(issueId)
    if (!entry) return
    this.state.running.delete(issueId)
    this.state.claimed.delete(issueId)
    if (entry.startedAt) this.state.agentTotals.secondsRunning += (Date.now() - entry.startedAt.getTime()) / 1000
    this.state.agentTotals.totalTokens += entry.totalTokens
    this.state.agentTotals.inputTokens += entry.inputTokens
    this.state.agentTotals.outputTokens += entry.outputTokens
    if (normal) {
      this.state.completed.add(issueId)
    } else {
      const nextAttempt = entry.retryAttempt + 1
      this.state.retryAttempts.set(issueId, { issueId, identifier: entry.identifier, attempt: nextAttempt, dueAtMs: Date.now() + backoffDelay(nextAttempt, this.maxRetryBackoffMs), error: 'worker_exit_abnormal' })
      this.state.claimed.add(issueId)
    }
    this.notifyObservers()
  }

  addObserver(callback: (state: OrchestratorState) => void): void { this.observers.push(callback) }

  private notifyObservers(): void {
    for (const cb of this.observers) {
      try { cb(this.state) } catch (err) { getLogger().warn({ error: String(err) }, 'observer_error') }
    }
  }
}
