import { describe, it, expect } from 'vitest'
import { buildServiceConfig, validateDispatchConfig, parseAndValidateConfig } from '../src/config.js'
import type { WorkflowDefinition } from '../src/models.js'

describe('buildServiceConfig', () => {
  it('builds config with defaults for missing fields', () => {
    const wf: WorkflowDefinition = { config: {}, promptTemplate: 'test' }
    const cfg = buildServiceConfig(wf)
    expect(cfg.tracker.kind).toBe('')
    expect(cfg.tracker.activeStates).toEqual(['Todo', 'In Progress'])
    expect(cfg.tracker.terminalStates).toEqual(['Done', 'Cancelled'])
    expect(cfg.polling.intervalMs).toBe(30000)
    expect(cfg.agent.maxConcurrentAgents).toBe(10)
    expect(cfg.agent.maxTurns).toBe(20)
    expect(cfg.agent.maxRetryBackoffMs).toBe(300000)
    expect(cfg.opencode.serverUrl).toBe('http://localhost:4096')
    expect(cfg.opencode.serverStartCommand).toBeNull()
    expect(cfg.opencode.stallTimeoutMs).toBe(300000)
    expect(cfg.opencode.sessionTimeoutMs).toBe(3600000)
    expect(cfg.hooks.timeoutMs).toBe(60000)
  })

  it('parses tracker config', () => {
    const wf: WorkflowDefinition = {
      config: { tracker: { kind: 'file_queue', active_states: ['In Progress'], terminal_states: ['Done'] } },
      promptTemplate: '',
    }
    const cfg = buildServiceConfig(wf)
    expect(cfg.tracker.kind).toBe('file_queue')
    expect(cfg.tracker.activeStates).toEqual(['In Progress'])
    expect(cfg.tracker.terminalStates).toEqual(['Done'])
  })

  it('carries no credential fields', () => {
    const wf: WorkflowDefinition = {
      config: { tracker: { kind: 'file_queue', api_key: '$SOME_SECRET', endpoint: 'https://example.invalid' } },
      promptTemplate: '',
    }
    const cfg = buildServiceConfig(wf)
    expect(Object.keys(cfg.tracker).sort()).toEqual(['activeStates', 'kind', 'terminalStates'])
    expect(JSON.stringify(cfg)).not.toContain('SOME_SECRET')
    expect(JSON.stringify(cfg)).not.toContain('example.invalid')
  })

  it('parses opencode config', () => {
    const wf: WorkflowDefinition = {
      config: { opencode: { server_url: 'http://localhost:4097', server_start_command: 'opencode serve --port 4097', stall_timeout_ms: 60000, session_timeout_ms: 1800000 } },
      promptTemplate: '',
    }
    const cfg = buildServiceConfig(wf)
    expect(cfg.opencode.serverUrl).toBe('http://localhost:4097')
    expect(cfg.opencode.serverStartCommand).toBe('opencode serve --port 4097')
    expect(cfg.opencode.stallTimeoutMs).toBe(60000)
    expect(cfg.opencode.sessionTimeoutMs).toBe(1800000)
  })

  it('lowercases per-state concurrency keys and drops non-positive values', () => {
    const wf: WorkflowDefinition = {
      config: { agent: { max_concurrent_agents_by_state: { 'In Progress': 3, Todo: 2 } } },
      promptTemplate: '',
    }
    const cfg = buildServiceConfig(wf)
    expect(cfg.agent.maxConcurrentAgentsByState).toEqual({ 'in progress': 3, todo: 2 })
  })

  it('rejects invalid max_turns', () => {
    const wf: WorkflowDefinition = { config: { agent: { max_turns: -1 } }, promptTemplate: '' }
    expect(() => buildServiceConfig(wf)).toThrow()
  })
})

describe('validateDispatchConfig', () => {
  it('returns error for missing tracker kind', () => {
    const cfg = buildServiceConfig({ config: {}, promptTemplate: '' })
    expect(validateDispatchConfig(cfg)).toContain('tracker.kind is required')
  })

  it('returns error for unsupported tracker kind', () => {
    const cfg = buildServiceConfig({ config: { tracker: { kind: 'jira' } }, promptTemplate: '' })
    expect(validateDispatchConfig(cfg)).toContain('unsupported tracker.kind: jira')
  })

  it('accepts the file_queue tracker kind', () => {
    const cfg = buildServiceConfig({ config: { tracker: { kind: 'file_queue' } }, promptTemplate: '' })
    expect(validateDispatchConfig(cfg)).toEqual([])
  })

  it('returns error for empty active_states', () => {
    const cfg = buildServiceConfig({
      config: { tracker: { kind: 'file_queue', active_states: [] } },
      promptTemplate: '',
    })
    expect(validateDispatchConfig(cfg)).toContain('tracker.active_states must not be empty')
  })
})

describe('parseAndValidateConfig', () => {
  it('applies defaults and reports validation errors together', () => {
    const { config, errors } = parseAndValidateConfig({ config: {}, promptTemplate: '' })
    expect(config.tracker.kind).toBe('')
    expect(config.polling.intervalMs).toBe(30000)
    expect(config.agent.maxTurns).toBe(20)
    expect(errors).toContain('tracker.kind is required')
  })
})
