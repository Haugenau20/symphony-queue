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
    // Assert the invariant, not the field list: no key may look like a
    // credential, and unknown keys must be dropped rather than passed through.
    // Pinning the exact key set instead would fail on any legitimate addition —
    // which is what it did when the gitlab tracker's base_url arrived — and a
    // test that cries wolf on safe changes stops guarding the unsafe ones.
    for (const key of Object.keys(cfg.tracker)) {
      expect(key).not.toMatch(/token|secret|password|api_?key|credential/i)
    }
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

  it('accepts the file_queue tracker kind with a root', () => {
    const cfg = buildServiceConfig({ config: { tracker: { kind: 'file_queue', root: '/srv/queue' } }, promptTemplate: '' })
    expect(validateDispatchConfig(cfg)).toEqual([])
  })

  it('requires tracker.root for the file_queue tracker', () => {
    const cfg = buildServiceConfig({ config: { tracker: { kind: 'file_queue' } }, promptTemplate: '' })
    expect(validateDispatchConfig(cfg)).toContain('tracker.root is required for the file_queue tracker')
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

describe('queue config', () => {
  it('defaults max_attempts and leaves root unset', () => {
    const cfg = buildServiceConfig({ config: { tracker: { kind: 'file_queue' } }, promptTemplate: '' })
    expect(cfg.tracker.maxAttempts).toBe(5)
    expect(cfg.tracker.root).toBeNull()
  })

  it('parses root and max_attempts', () => {
    const cfg = buildServiceConfig({
      config: { tracker: { kind: 'file_queue', root: '/srv/queue', max_attempts: 3 } },
      promptTemplate: '',
    })
    expect(cfg.tracker.root).toBe('/srv/queue')
    expect(cfg.tracker.maxAttempts).toBe(3)
  })

  it('resolves a relative root against the workflow directory', () => {
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'file_queue', root: 'queue' } }, promptTemplate: '' },
      '/srv/project',
    )
    expect(cfg.tracker.root).toBe('/srv/project/queue')
  })

  it('rejects a non-positive max_attempts', () => {
    expect(() => buildServiceConfig({
      config: { tracker: { kind: 'file_queue', max_attempts: 0 } },
      promptTemplate: '',
    })).toThrow()
  })
})

describe('gitlab tracker config', () => {
  const gl = (tracker: Record<string, unknown>) =>
    buildServiceConfig({ config: { tracker: { kind: 'gitlab', ...tracker } }, promptTemplate: '' })

  const complete = { base_url: 'https://gitlab.example', project_id: 'group/project' }

  it('accepts gitlab as a supported kind', () => {
    const errs = validateDispatchConfig(gl(complete))
    expect(errs).not.toContain('unsupported tracker.kind: gitlab')
  })

  it('requires base_url and project_id', () => {
    const errs = validateDispatchConfig(gl({}))
    expect(errs).toContain('tracker.base_url is required for the gitlab tracker')
    expect(errs).toContain('tracker.project_id is required for the gitlab tracker')
  })

  it('requires the token in the environment, not the workflow file', () => {
    const prev = process.env.SYMPHONY_GITLAB_TOKEN
    try {
      delete process.env.SYMPHONY_GITLAB_TOKEN
      expect(validateDispatchConfig(gl(complete)))
        .toContain('SYMPHONY_GITLAB_TOKEN must be set in the environment for the gitlab tracker')

      process.env.SYMPHONY_GITLAB_TOKEN = 'glpat-x'
      expect(validateDispatchConfig(gl(complete))).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.SYMPHONY_GITLAB_TOKEN
      else process.env.SYMPHONY_GITLAB_TOKEN = prev
    }
  })

  it('has no config field that could carry a secret', () => {
    // The gitlab tracker config is deliberately token-free (DESIGN §8.3): if a
    // `token`/`api_key` key ever appears here, a secret can reach a file on
    // disk and this test is the thing that should stop it.
    const cfg = gl({ ...complete, token: 'glpat-leaked', api_key: 'also-leaked' })
    expect(JSON.stringify(cfg)).not.toContain('leaked')
  })

  it('defaults the label prefix and closed states', () => {
    const cfg = gl(complete)
    expect(cfg.tracker.labelPrefix).toBe('symphony')
    expect(cfg.tracker.closedStates).toEqual(['Done', 'Cancelled'])
  })

  it('does not require tracker.root', () => {
    const prev = process.env.SYMPHONY_GITLAB_TOKEN
    process.env.SYMPHONY_GITLAB_TOKEN = 'glpat-x'
    try {
      expect(validateDispatchConfig(gl(complete)))
        .not.toContain('tracker.root is required for the file_queue tracker')
    } finally {
      if (prev === undefined) delete process.env.SYMPHONY_GITLAB_TOKEN
      else process.env.SYMPHONY_GITLAB_TOKEN = prev
    }
  })
})
