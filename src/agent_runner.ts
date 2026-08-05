import type { Issue } from './models.js'
import { getLogger } from './log.js'
import type { OpencodeClient, PermissionRule } from '@opencode-ai/sdk/v2'

export interface AgentRunResult {
  sessionId: string | null
  success: boolean
  error?: string
  turnsCompleted: number
}

/** One observed sign of life from a running agent. */
export interface AgentActivity {
  issueId: string
  sessionId: string
  /** The SDK event type, or a synthetic name for the milestones we raise. */
  event: string | null
  at: Date
}

export interface AgentRunnerConfig {
  maxTurns: number
  issueStateFetcher: (issueIds: string[]) => Promise<Issue[]>
  /**
   * Called whenever the agent shows a sign of life. This is the input the
   * stall detector was missing: without it `stall_timeout_ms` can only be
   * compared against the moment the run STARTED, which makes it a wall-clock
   * run timeout wearing a stall detector's name.
   */
  onActivity?: (activity: AgentActivity) => void
}

const PERMISSIONS: PermissionRule[] = [
  { permission: 'edit',               pattern: '*', action: 'allow' },
  { permission: 'bash',               pattern: '*', action: 'allow' },
  { permission: 'webfetch',           pattern: '*', action: 'allow' },
  { permission: 'doom_loop',          pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'allow' },
]

const CONTINUATION_GUIDANCE = (turn: number, maxTurns: number) => `
Continuation guidance:

- The previous turn completed normally, but the queue item is still in an active state, so the work is not finished.
- This is continuation turn ${turn} of ${maxTurns} for the current agent run.
- Resume from the current workspace state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Keep the Workpad section of the queue item up to date with your running plan, so the work is resumable if this run is interrupted.
- Focus on the remaining work and do not end the turn while the item stays active unless you are truly blocked.
`

export class AgentRunner {
  constructor(
    private client: OpencodeClient,
    private config: AgentRunnerConfig,
  ) {}

  async run(issue: Issue, prompt: string): Promise<AgentRunResult> {
    const log = getLogger()
    let sessionId: string | null = null
    // Closing this closes the event subscription. Without it the SSE
    // connection outlives the run it was watching.
    const pumpStop = new AbortController()
    try {
      const created = await this.client.session.create({
        title: `${issue.identifier}: ${issue.title}`,
        permission: PERMISSIONS,
      })
      sessionId = created.data!.id
      log.info({ issueId: issue.id, sessionId }, 'session_created')
      this.reportActivity(issue.id, sessionId, 'session_created')
      // Deliberately not awaited: it runs for as long as the session does.
      void this.pumpSessionEvents(issue.id, sessionId, pumpStop.signal)

      const result = await this.client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
      })
      if (result.error) {
        return { sessionId, success: false, error: 'initial_prompt_failed', turnsCompleted: 0 }
      }

      let turnsCompleted = 1
      this.reportActivity(issue.id, sessionId, 'turn_completed')
      for (let turn = 2; turn <= this.config.maxTurns; turn++) {
        const refreshedIssue = await this.refreshIssueState(issue.id)
        if (!refreshedIssue || !this.isActiveState(refreshedIssue.state)) {
          log.info({ issueId: issue.id, turnsCompleted: turn - 1 }, 'issue_no_longer_active')
          break
        }

        const contResult = await this.client.session.prompt({
          sessionID: sessionId,
          parts: [{ type: 'text', text: CONTINUATION_GUIDANCE(turn, this.config.maxTurns) }],
        })
        if (contResult.error) {
          log.warn({ issueId: issue.id, sessionId, turn }, 'continuation_turn_failed')
          return { sessionId, success: false, error: 'continuation_turn_failed', turnsCompleted }
        }

        turnsCompleted = turn
        this.reportActivity(issue.id, sessionId, 'turn_completed')
      }

      log.info({ issueId: issue.id, turnsCompleted }, 'agent_run_completed')
      return { sessionId, success: true, turnsCompleted }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ issueId: issue.id, error: message }, 'agent_run_failed')
      return { sessionId: null, success: false, error: message, turnsCompleted: 0 }
    } finally {
      pumpStop.abort()
    }
  }

  /**
   * Follow the session's event stream and report every event as activity.
   *
   * A turn boundary is already a liveness signal, but turns are exactly the
   * thing that runs long: an agent cloning a repository and building it can
   * spend half an hour inside one. The event stream is what distinguishes
   * "working" from "wedged" at any finer grain than that.
   *
   * Per-session rather than the global `/event` stream on purpose: a global
   * subscription would have to be filtered by session id, and a filter that is
   * wrong in the permissive direction stamps one run's activity onto another
   * and reports a genuinely wedged agent as healthy. Subscribing by id cannot
   * make that mistake.
   *
   * Sessions are created through the v1-shaped `session.create` and watched
   * through the v2 `session.events`. If those id spaces ever diverge, this call
   * fails, `agent_event_stream_unavailable` says so, and the detector degrades
   * to turn boundaries — which is exactly what existed before it.
   */
  private async pumpSessionEvents(issueId: string, sessionId: string, signal: AbortSignal): Promise<void> {
    if (!this.config.onActivity) return
    try {
      const { stream } = await this.client.v2.session.events({ sessionID: sessionId }, { signal })
      for await (const event of stream) {
        if (signal.aborted) return
        const type = (event as { type?: unknown } | null)?.type
        this.reportActivity(issueId, sessionId, typeof type === 'string' ? type : null)
      }
    } catch (err) {
      // Losing the stream must not fail the run. It degrades to the turn
      // boundaries above — which is the whole of what existed before — so the
      // worst case is the coarser signal, not a dead agent.
      if (!signal.aborted) {
        getLogger().warn({ issueId, sessionId, error: String(err) }, 'agent_event_stream_unavailable')
      }
    }
  }

  private reportActivity(issueId: string, sessionId: string, event: string | null): void {
    try {
      this.config.onActivity?.({ issueId, sessionId, event, at: new Date() })
    } catch (err) {
      getLogger().warn({ issueId, error: String(err) }, 'activity_callback_failed')
    }
  }

  private async refreshIssueState(issueId: string): Promise<Issue | null> {
    try {
      const issues = await this.config.issueStateFetcher([issueId])
      return issues[0] ?? null
    } catch {
      return null
    }
  }

  private isActiveState(state: string): boolean {
    const terminalStates = ['closed', 'cancelled', 'canceled', 'duplicate', 'done']
    return !terminalStates.includes(state.toLowerCase())
  }
}
