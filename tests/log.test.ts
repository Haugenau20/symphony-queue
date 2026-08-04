import { describe, it, expect } from 'vitest'
import type { AgentEventType, AgentEvent, TurnResult, AgentRunUpdate } from '../src/events.js'
import { configureLogging, getLogger, withIssueContext, withSessionContext } from '../src/log.js'

describe('events', () => {
  it('creates an AgentEvent', () => {
    const ev: AgentEvent = { event: 'session_started', timestamp: new Date().toISOString() }
    expect(ev.event).toBe('session_started')
    expect(ev.timestamp).toBeDefined()
  })

  it('creates a TurnResult', () => {
    const tr: TurnResult = {
      sessionId: 's1', threadId: 't1', turnId: 't1',
      status: 'completed',
      tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      events: [],
    }
    expect(tr.status).toBe('completed')
    expect(tr.tokenUsage.totalTokens).toBe(30)
  })

  it('creates an AgentRunUpdate', () => {
    const ar: AgentRunUpdate = { issueId: 'i1', type: 'token_usage', data: { tokens: 100 } }
    expect(ar.type).toBe('token_usage')
  })

  it('AgentEventType is a string union', () => {
    const valid: AgentEventType = 'turn_completed'
    const also: AgentEventType = 'notification'
    expect(valid).toBe('turn_completed')
    expect(also).toBe('notification')
  })
})

describe('log', () => {
  it('returns a logger', () => {
    const log = getLogger()
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
  })

  it('can be reconfigured', () => {
    configureLogging({ level: 'debug' })
    const log = getLogger()
    expect(log.level).toBe('debug')
  })
})

describe('structured logging', () => {
  it('withIssueContext returns a child logger', () => {
    const log = withIssueContext(getLogger(), { issueId: 'abc', issueIdentifier: 'TICKET-1' })
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
    expect(typeof log.child).toBe('function')
  })

  it('withSessionContext returns a child logger', () => {
    const log = withSessionContext(getLogger(), 'session-123')
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
    expect(typeof log.child).toBe('function')
  })
})
