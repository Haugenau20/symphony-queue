import { describe, it, expect, vi } from 'vitest'
import { AgentRunner, declaresCompletion, promptText } from '../src/agent_runner.js'
import type { Issue } from '../src/models.js'

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1', identifier: 'TICKET-1', title: 'Test', state: 'In Progress',
    description: null, priority: null, branchName: null, url: null,
    labels: [], blockedBy: [], createdAt: null, updatedAt: null,
    ...overrides,
  } as Issue
}

/**
 * Stands in for the SDK's `{ stream: AsyncGenerator }`: yields `events`, then
 * stays open the way a real subscription does for the life of the session.
 */
function eventStream(events: unknown[], signalBox?: { signal?: AbortSignal }) {
  return vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
    if (signalBox) signalBox.signal = options?.signal
    const stream = (async function* () {
      for (const e of events) yield e
      await new Promise(() => {})
    })()
    return { stream } as any
  })
}

function mockClient(opts?: {
  createFail?: boolean
  promptFail?: boolean
  events?: unknown[]
  eventsFail?: boolean
  signalBox?: { signal?: AbortSignal }
}) {
  const events = opts?.eventsFail
    ? vi.fn().mockRejectedValue(new Error('no such session'))
    : eventStream(opts?.events ?? [], opts?.signalBox)
  return {
    session: {
      create: opts?.createFail
        ? vi.fn().mockRejectedValue(new Error('create failed'))
        : vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
      prompt: opts?.promptFail
        ? vi.fn().mockResolvedValue({ error: 'prompt failed' })
        : vi.fn().mockResolvedValue({ data: {} }),
    },
    v2: { session: { events } },
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

describe('AgentRunner completion marker', () => {
  // Without a completion signal the turn loop has no exit but exhaustion.
  // Symphony owns the item's state and does not move it until the run is over,
  // so "is the item still active?" is true on every iteration — an agent that
  // finished at turn 3 of 10 is told "the work is not finished" seven more
  // times, with a live credential and a pushed branch to fiddle with.
  const reply = (text: string) => ({ data: { parts: [{ type: 'text', text }] } })

  function clientReplying(...texts: string[]) {
    let n = 0
    return {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        prompt: vi.fn(async () => reply(texts[Math.min(n++, texts.length - 1)] ?? '')),
      },
      v2: { session: { events: eventStream([]) } },
    } as any
  }

  it('stops as soon as the agent declares itself finished', async () => {
    const client = clientReplying('still working', 'nearly there', 'all done\nSYMPHONY_DONE')
    const runner = new AgentRunner(client, {
      maxTurns: 10,
      issueStateFetcher: async () => [makeIssue()],
      completionMarker: 'SYMPHONY_DONE',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.turnsCompleted).toBe(3)
    expect(result.stopReason).toBe('completed')
    expect(client.session.prompt).toHaveBeenCalledTimes(3)
  })

  it('can finish on the very first turn', async () => {
    const client = clientReplying('done immediately\nSYMPHONY_DONE')
    const runner = new AgentRunner(client, {
      maxTurns: 10,
      issueStateFetcher: async () => [makeIssue()],
      completionMarker: 'SYMPHONY_DONE',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.turnsCompleted).toBe(1)
    expect(result.stopReason).toBe('completed')
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
  })

  it('reports max_turns when the agent never declared itself finished', async () => {
    // The distinction the logs could not previously make: interrupted mid-task
    // looks identical to finished, and both are filed as reviewable.
    const client = clientReplying('working')
    const runner = new AgentRunner(client, {
      maxTurns: 4,
      issueStateFetcher: async () => [makeIssue()],
      completionMarker: 'SYMPHONY_DONE',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.turnsCompleted).toBe(4)
    expect(result.stopReason).toBe('max_turns')
  })

  it('ignores the marker quoted inside a sentence', async () => {
    // Agents narrate their own instructions. A substring match would read
    // "I'll reply with SYMPHONY_DONE when the MR is open" as the declaration
    // itself and cut the run off before any work happened.
    const client = clientReplying("I will reply with SYMPHONY_DONE once the MR is open.", 'working', 'working', 'working')
    const runner = new AgentRunner(client, {
      maxTurns: 3,
      issueStateFetcher: async () => [makeIssue()],
      completionMarker: 'SYMPHONY_DONE',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.stopReason).toBe('max_turns')
    expect(result.turnsCompleted).toBe(3)
  })

  it('uses every turn when the marker is disabled', async () => {
    const client = clientReplying('SYMPHONY_DONE')
    const runner = new AgentRunner(client, {
      maxTurns: 3,
      issueStateFetcher: async () => [makeIssue()],
      completionMarker: '',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.turnsCompleted).toBe(3)
    expect(result.stopReason).toBe('max_turns')
  })

  it('reports issue_inactive when a human ends the item mid-run', async () => {
    const client = clientReplying('working')
    const runner = new AgentRunner(client, {
      maxTurns: 5,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      completionMarker: 'SYMPHONY_DONE',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.stopReason).toBe('issue_inactive')
    expect(result.turnsCompleted).toBe(1)
  })
})

describe('declaresCompletion', () => {
  it('matches only a whole line', () => {
    expect(declaresCompletion('work done\nSYMPHONY_DONE', 'SYMPHONY_DONE')).toBe(true)
    expect(declaresCompletion('  SYMPHONY_DONE  ', 'SYMPHONY_DONE')).toBe(true)
    expect(declaresCompletion('I will say SYMPHONY_DONE later', 'SYMPHONY_DONE')).toBe(false)
    expect(declaresCompletion('SYMPHONY_DONE_NOT', 'SYMPHONY_DONE')).toBe(false)
    expect(declaresCompletion('anything', '')).toBe(false)
  })
})

describe('promptText', () => {
  it('joins text parts and ignores everything else', () => {
    expect(promptText({ parts: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }] }))
      .toBe('a\nb')
    expect(promptText(null)).toBe('')
    expect(promptText({})).toBe('')
  })
})

describe('AgentRunner session working directory', () => {
  it('builds its client rooted at the workspace it was handed', async () => {
    // The prompt already names the workspace in prose, but prose does not
    // reach the file-search tools — an unrooted session indexes from the
    // server's default, which on a fresh OpenCode server is `/`.
    const asked: Array<string | null> = []
    const client = mockClient()
    const runner = new AgentRunner((dir) => { asked.push(dir); return client }, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    await runner.run(makeIssue(), 'do work', '/workspaces/TICKET-1')
    expect(asked).toEqual(['/workspaces/TICKET-1'])
  })

  it('asks for the default root when there is no workspace', async () => {
    const asked: Array<string | null> = []
    const client = mockClient()
    const runner = new AgentRunner((dir) => { asked.push(dir); return client }, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    await runner.run(makeIssue(), 'do work')
    expect(asked).toEqual([null])
  })

  it('builds a fresh client per run, so two items cannot share a root', async () => {
    const asked: Array<string | null> = []
    const client = mockClient()
    const runner = new AgentRunner((dir) => { asked.push(dir); return client }, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    await runner.run(makeIssue({ id: 'a' }), 'work', '/workspaces/A')
    await runner.run(makeIssue({ id: 'b' }), 'work', '/workspaces/B')
    expect(asked).toEqual(['/workspaces/A', '/workspaces/B'])
  })

  it('still accepts a plain client, which roots every session the same way', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    const result = await runner.run(makeIssue(), 'do work', '/workspaces/TICKET-1')
    expect(result.success).toBe(true)
    expect(client.session.create).toHaveBeenCalled()
  })
})

describe('AgentRunner activity reporting', () => {
  // stall_timeout_ms is only a stall detector if something reports activity.
  // Without these signals it compares against the run's start time and becomes
  // a wall-clock run timeout, killing healthy long runs.
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('reports session creation and every completed turn', async () => {
    const seen: string[] = []
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 2,
      issueStateFetcher: async () => [makeIssue()],
      onActivity: (a) => seen.push(a.event ?? '?'),
    })
    await runner.run(makeIssue(), 'do work')
    expect(seen).toEqual(['session_created', 'turn_completed', 'turn_completed'])
  })

  it('reports each event the session stream emits, while the turn is running', async () => {
    // Turn boundaries alone are too coarse: a single turn that clones a repo
    // and builds it can outlive any sane timeout while making steady progress.
    // The prompt here takes a few ticks so the stream can interleave with it,
    // which is the only arrangement in which these events matter — once the
    // run ends the subscription is closed and its events are moot.
    const seen: string[] = []
    const client = mockClient({ events: [{ type: 'message.part.updated' }, { type: 'tool.executed' }] })
    client.session.prompt = vi.fn(async () => {
      for (let i = 0; i < 5; i++) await flush()
      return { data: {} }
    })
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: (a) => seen.push(a.event ?? '?'),
    })
    await runner.run(makeIssue(), 'do work')
    expect(seen).toContain('message.part.updated')
    expect(seen).toContain('tool.executed')
  })

  it('subscribes to the session it created, not to everything', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: () => {},
    })
    await runner.run(makeIssue(), 'do work')
    expect(client.v2.session.events).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-1' }),
      expect.anything(),
    )
  })

  it('stamps activity with the issue and session it belongs to', async () => {
    const seen: Array<{ issueId: string; sessionId: string }> = []
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: (a) => seen.push({ issueId: a.issueId, sessionId: a.sessionId }),
    })
    await runner.run(makeIssue({ id: 'issue-9' }), 'do work')
    expect(seen[0]).toEqual({ issueId: 'issue-9', sessionId: 'session-1' })
  })

  it('closes the subscription when the run ends', async () => {
    // Otherwise every run leaks an open SSE connection for the life of the
    // orchestrator.
    const signalBox: { signal?: AbortSignal } = {}
    const client = mockClient({ signalBox })
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: () => {},
    })
    await runner.run(makeIssue(), 'do work')
    await flush()
    expect(signalBox.signal?.aborted).toBe(true)
  })

  it('stops consuming the stream once the run has ended', async () => {
    // The transport is asked to close via the abort signal, but a stream that
    // ignored it would keep reporting activity for a run that is over — and an
    // entry that keeps being stamped is one the stall detector can never time
    // out. So the loop checks for itself rather than trusting the transport.
    const seen: string[] = []
    const client = mockClient()
    client.v2.session.events = vi.fn(async () => ({
      stream: (async function* () {
        for (;;) { yield { type: 'tick' }; await flush() }
      })(),
    })) as any
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: (a) => seen.push(a.event ?? '?'),
    })
    await runner.run(makeIssue(), 'do work')
    await flush(); await flush()
    const settled = seen.length
    await flush(); await flush(); await flush()
    expect(seen.length).toBe(settled)
  })

  it('completes the run when the event stream is unavailable', async () => {
    // Degrades to turn boundaries — the whole of what existed before — rather
    // than failing a run because a diagnostic could not be attached.
    const seen: string[] = []
    const client = mockClient({ eventsFail: true })
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: (a) => seen.push(a.event ?? '?'),
    })
    const result = await runner.run(makeIssue(), 'do work')
    await flush()
    expect(result.success).toBe(true)
    expect(seen).toEqual(['session_created', 'turn_completed'])
  })

  it('does not fail a run because the activity callback threw', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
      onActivity: () => { throw new Error('observer blew up') },
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.success).toBe(true)
  })

  it('does not subscribe at all when nobody is listening', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 1,
      issueStateFetcher: async () => [makeIssue({ state: 'Done' })],
    })
    await runner.run(makeIssue(), 'do work')
    await flush()
    expect(client.v2.session.events).not.toHaveBeenCalled()
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

  it('tells the agent how much runway is left', async () => {
    // Running out of turns mid-task is the normal failure of a smaller model:
    // it keeps refining while the finishing step goes undone, and the run then
    // exits "cleanly" with nothing to show for it.
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 3,
      issueStateFetcher: async () => [makeIssue()],
    })
    await runner.run(makeIssue(), 'do work')
    const last = client.session.prompt.mock.calls[2][0].parts[0].text
    expect(last).toContain('turn 3 of 3')
    expect(last).toContain('0 turn(s) remain')
    expect(last).toMatch(/finishing step/)
  })

  it('does not describe the workpad as a section of a queue item', async () => {
    // That is the FILE QUEUE's storage described as though it were universal.
    // Under the gitlab tracker there is no item file and the workpad is an
    // issue comment, so the instruction pointed at nothing.
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 2,
      issueStateFetcher: async () => [makeIssue()],
    })
    await runner.run(makeIssue(), 'do work')
    const cont = client.session.prompt.mock.calls[1][0].parts[0].text
    expect(cont).not.toContain('queue item')
    expect(cont).toContain('workpad')
  })

  it('lets the workflow replace the guidance to name its own finishing step', async () => {
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 2,
      issueStateFetcher: async () => [makeIssue()],
      continuationGuidance: 'Turn {{ turn }}/{{ max_turns }}. Open the merge request before you stop.',
    })
    await runner.run(makeIssue(), 'do work')
    const cont = client.session.prompt.mock.calls[1][0].parts[0].text
    expect(cont).toBe('Turn 2/2. Open the merge request before you stop.')
  })

  it('falls back to the default when the workflow template is broken', async () => {
    // A bad template in WORKFLOW.md must not strand a run already under way.
    const client = mockClient()
    const runner = new AgentRunner(client, {
      maxTurns: 2,
      issueStateFetcher: async () => [makeIssue()],
      continuationGuidance: 'broken {{ unclosed',
    })
    const result = await runner.run(makeIssue(), 'do work')
    expect(result.success).toBe(true)
    expect(client.session.prompt.mock.calls[1][0].parts[0].text).toContain('Continuation guidance')
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
