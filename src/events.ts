export type AgentEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_auto_approved'
  | 'unsupported_tool_call'
  | 'notification'
  | 'other_message'
  | 'malformed'

export interface AgentEvent {
  event: AgentEventType
  timestamp: string
  sessionId?: string
  turnId?: string
  agentServerPid?: string | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  payload?: Record<string, unknown>
}

export interface TurnResult {
  sessionId: string
  threadId: string
  turnId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'input_required'
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  events: AgentEvent[]
}

export interface AgentRunUpdate {
  issueId: string
  type: 'token_usage' | 'event' | 'status_change' | 'error'
  data: Record<string, unknown>
}
