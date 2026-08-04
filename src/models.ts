import type { AgentEventType } from './events.js'

export interface BlockerRef {
  id: string | null
  identifier: string | null
  state: string | null
}

export interface Issue {
  id: string
  identifier: string
  title: string
  state: string
  description: string | null
  priority: number | null
  branchName: string | null
  url: string | null
  labels: string[]
  blockedBy: BlockerRef[]
  createdAt: Date | null
  updatedAt: Date | null
}

export interface WorkflowDefinition {
  config: Record<string, unknown>
  promptTemplate: string
}

export interface Workspace {
  path: string
  workspaceKey: string
  createdNow: boolean
}

export interface LiveSession {
  sessionId: string
  threadId: string
  turnId: string
  agentServerPid: string | null
  lastAgentEvent: AgentEventType | null
  lastAgentTimestamp: Date | null
  lastAgentMessage: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  lastReportedInputTokens: number
  lastReportedOutputTokens: number
  lastReportedTotalTokens: number
  turnCount: number
}

export interface RetryEntry {
  issueId: string
  identifier: string
  attempt: number
  dueAtMs: number
  error: string | null
}

export interface RunningEntry {
  session: LiveSession | null
  issueId: string
  identifier: string
  issue: Issue
  sessionId: string | null
  lastAgentEvent: string | null
  lastAgentTimestamp: Date | null
  lastAgentMessage: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  lastReportedInputTokens: number
  lastReportedOutputTokens: number
  lastReportedTotalTokens: number
  retryAttempt: number
  startedAt: Date | null
  task: Promise<void> | null
  cancel: (() => void) | null
}

export interface AgentTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  secondsRunning: number
}

export function createAgentTotals(): AgentTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 }
}

export interface OrchestratorState {
  pollIntervalMs: number
  maxConcurrentAgents: number
  running: Map<string, RunningEntry>
  claimed: Set<string>
  retryAttempts: Map<string, RetryEntry>
  completed: Set<string>
  agentTotals: AgentTotals
  agentRateLimits: unknown
  maxConcurrentAgentsByState: Record<string, number>
}

export function createOrchestratorState(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    pollIntervalMs: 30000,
    maxConcurrentAgents: 10,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    agentTotals: createAgentTotals(),
    agentRateLimits: null,
    maxConcurrentAgentsByState: {},
    ...overrides,
  }
}
