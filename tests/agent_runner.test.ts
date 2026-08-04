import { describe, it, expect, vi } from 'vitest'
import { AgentRunner } from '../src/agent_runner.js'
import type { Issue } from '../src/models.js'

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1', identifier: 'TICKET-1', title: 'Test', state: 'In Progress',
    description: null, priority: null, branchName: null, url: null,
    labels: [], blockedBy: [], createdAt: null, updatedAt: null,
    ...overrides,
  } as Issue
}

function mockClient(opts?: {
  createFail?: boolean
  promptFail?: boolean
}) {
  return {
    session: {
      create: opts?.createFail
        ? vi.fn().mockRejectedValue(new Error('create failed'))
        : vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
      prompt: opts?.promptFail
        ? vi.fn().mockResolvedValue({ error: 'prompt failed' })
        : vi.fn().mockResolvedValue({ data: {} }),
    },
  } as any
}

describe('AgentRunner (SDK v2)', () => {
  it('creates session and sends prompt', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    const result = await runner.run(makeIssue(), 'Work on this')
    expect(result.success).toBe(true)
    expect(result.sessionId).toBe('session-1')
    expect(result.turnsCompleted).toBe(1)
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'TICKET-1: Test',
    }))
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-1' })
    )
  })

  it('handles createSession failure', async () => {
    const client = mockClient({ createFail: true })
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [],
    })
    const result = await runner.run(makeIssue(), 'Work')
    expect(result.success).toBe(false)
    expect(result.error).toContain('create failed')
    expect(result.turnsCompleted).toBe(0)
  })

  it('handles initial prompt API error', async () => {
    const client = mockClient({ promptFail: true })
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [],
    })
    const result = await runner.run(makeIssue(), 'Work')
    expect(result.success).toBe(false)
    expect(result.error).toContain('initial_prompt_failed')
  })

  it('handles prompt network error', async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        prompt: vi.fn().mockRejectedValue(new Error('network error')),
      },
    } as any
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [],
    })
    const result = await runner.run(makeIssue(), 'Work')
    expect(result.success).toBe(false)
    expect(result.error).toContain('network error')
  })

  it('includes permissions in session create', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    await runner.run(makeIssue(), 'do work')
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: expect.arrayContaining([
          expect.objectContaining({ permission: 'edit', pattern: '*', action: 'allow' }),
          expect.objectContaining({ permission: 'bash', pattern: '*', action: 'allow' }),
          expect.objectContaining({ permission: 'doom_loop', pattern: '*', action: 'allow' }),
          expect.objectContaining({ permission: 'external_directory', pattern: '*', action: 'allow' }),
        ]),
      })
    )
  })
})

describe('AgentRunner continuation turns', () => {
  it('loops through multiple turns when issue stays active', async () => {
    let fetcherCalls = 0
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 3,
      issueStateFetcher: async () => {
        fetcherCalls++
        return [makeIssue()] // always active (In Progress)
      },
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.success).toBe(true)
    expect(result.turnsCompleted).toBe(3)
    expect(client.session.prompt).toHaveBeenCalledTimes(3)
  })

  it('stops when issue state is no longer active', async () => {
    let fetcherCalls = 0
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 10,
      issueStateFetcher: async () => {
        fetcherCalls++
        if (fetcherCalls >= 2) return [makeIssue({ state: 'Done' })]
        return [makeIssue()]
      },
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.success).toBe(true)
    expect(result.turnsCompleted).toBe(2)
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  it('uses continuation guidance for subsequent turns', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 2,
      issueStateFetcher: async () => [makeIssue()],
    })
    await runner.run(makeIssue(), 'do work')
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    // Second call should use continuation guidance, not the full prompt
    const firstCall = client.session.prompt.mock.calls[0][0]
    const secondCall = client.session.prompt.mock.calls[1][0]
    expect(firstCall.parts[0].text).toContain('do work')
    expect(secondCall.parts[0].text).toContain('Continuation guidance')
  })
})
