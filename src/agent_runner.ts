import type { Issue } from './models.js'
import { getLogger } from './log.js'
import { renderContinuation } from './prompt_builder.js'
import type { OpencodeClient, PermissionRule } from '@opencode-ai/sdk/v2'

/**
 * Builds a client rooted at a given directory, or at the server's default when
 * given null.
 *
 * A factory rather than a client because `directory` is client-level config in
 * the SDK, and symphony gives every item its own workspace. One shared client
 * means every session roots wherever the server defaults — `/` for a fresh
 * OpenCode server — so the agent's file-search tools index the whole container
 * instead of the twenty files it is supposed to be working on. The prompt
 * carries an absolute workspace path, which is why this worked at all, but
 * "works" and "is rooted correctly" are not the same thing.
 */
export type OpencodeClientFactory = (directory: string | null) => OpencodeClient

export interface AgentRunResult {
  sessionId: string | null
  success: boolean
  error?: string
  turnsCompleted: number
  /**
   * Why the turn loop ended. `max_turns` means the agent was INTERRUPTED — it
   * never said it was finished — and the item is about to be filed as reviewable
   * anyway. That distinction was previously unrecoverable from the logs: a run
   * that finished and one that ran out of runway looked identical.
   */
  stopReason?: 'completed' | 'max_turns' | 'issue_inactive'
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
  /**
   * Overrides DEFAULT_CONTINUATION_GUIDANCE. Liquid, with `turn`, `max_turns`
   * and `turns_remaining` in scope. This is where a workflow says what
   * "finished" means for its tracker — the default cannot, since "open a merge
   * request" is right for GitLab and meaningless for the file queue.
   */
  continuationGuidance?: string | null
  /**
   * The line an agent emits to declare itself finished. Empty disables the
   * check, which restores the old behaviour: every run uses every turn.
   */
  completionMarker?: string | null
}

const PERMISSIONS: PermissionRule[] = [
  { permission: 'edit',               pattern: '*', action: 'allow' },
  { permission: 'bash',               pattern: '*', action: 'allow' },
  { permission: 'webfetch',           pattern: '*', action: 'allow' },
  { permission: 'doom_loop',          pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'allow' },
]

/**
 * Sent at the start of every turn after the first, unless the workflow supplies
 * its own via `agent.continuation_guidance`.
 *
 * Deliberately tracker-neutral. It used to say "keep the Workpad section of the
 * queue item up to date", which is the file queue's storage described as though
 * it were universal — under the gitlab tracker there is no item file and the
 * workpad is an issue comment, so the instruction pointed at nothing.
 *
 * `turns_remaining` is here because running out of turns mid-task is the normal
 * failure of a smaller model: it keeps refining while the finishing step goes
 * undone, and the run then exits "cleanly" with nothing to show. Telling it how
 * much runway is left is the cheapest available correction.
 */
export const DEFAULT_CONTINUATION_GUIDANCE = `
Continuation guidance:

- The previous turn completed normally, but the work item is still in an active state, so the work is not finished.
- This is continuation turn {{ turn }} of {{ max_turns }}; {{ turns_remaining }} turn(s) remain after this one.
- Resume from the current workspace state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Keep your workpad up to date, in the form the task instructions specified, so the work is resumable if this run is interrupted.
- If the finishing step named in the task instructions is still undone and the turns are running out, do it now rather than continuing to refine.
- Focus on the remaining work and do not end the turn while the item stays active unless you are truly blocked.
`

/**
 * True when `text` contains `marker` on a line of its own.
 *
 * Whole-line rather than substring: agents narrate their instructions ("I'll
 * reply with SYMPHONY_DONE once the MR is open"), and a substring match would
 * read that as the declaration itself and cut the run off mid-task.
 */
export function declaresCompletion(text: string, marker: string): boolean {
  if (!marker) return false
  return text.split('\n').some((line) => line.trim() === marker)
}

/** Concatenate the text parts of a prompt response; ignore tool and file parts. */
export function promptText(data: unknown): string {
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> } | null)?.parts
  if (!Array.isArray(parts)) return ''
  return parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('\n')
}

export class AgentRunner {
  private readonly clientFor: OpencodeClientFactory

  constructor(
    client: OpencodeClient | OpencodeClientFactory,
    private config: AgentRunnerConfig,
  ) {
    this.clientFor = typeof client === 'function' ? client : () => client
  }

  async run(issue: Issue, prompt: string, workspacePath?: string | null): Promise<AgentRunResult> {
    const log = getLogger()
    let sessionId: string | null = null
    // Closing this closes the event subscription. Without it the SSE
    // connection outlives the run it was watching.
    const pumpStop = new AbortController()
    // Root the session at the item's workspace. The prompt says the same thing
    // in prose, but prose does not reach the file-search tools.
    const client = this.clientFor(workspacePath ?? null)
    try {
      const created = await client.session.create({
        title: `${issue.identifier}: ${issue.title}`,
        permission: PERMISSIONS,
      })
      sessionId = created.data!.id
      log.info({ issueId: issue.id, sessionId }, 'session_created')
      this.reportActivity(issue.id, sessionId, 'session_created')
      // Deliberately not awaited: it runs for as long as the session does.
      void this.pumpSessionEvents(client, issue.id, sessionId, pumpStop.signal)

      const result = await client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
      })
      if (result.error) {
        return { sessionId, success: false, error: 'initial_prompt_failed', turnsCompleted: 0 }
      }

      let turnsCompleted = 1
      this.reportActivity(issue.id, sessionId, 'turn_completed')
      const marker = this.config.completionMarker ?? ''
      if (declaresCompletion(promptText(result.data), marker)) {
        log.info({ issueId: issue.id, turnsCompleted }, 'agent_reported_complete')
        return { sessionId, success: true, turnsCompleted, stopReason: 'completed' }
      }

      let stopReason: AgentRunResult['stopReason'] = 'max_turns'
      for (let turn = 2; turn <= this.config.maxTurns; turn++) {
        const refreshedIssue = await this.refreshIssueState(issue.id)
        if (!refreshedIssue || !this.isActiveState(refreshedIssue.state)) {
          log.info({ issueId: issue.id, turnsCompleted: turn - 1 }, 'issue_no_longer_active')
          stopReason = 'issue_inactive'
          break
        }

        const contResult = await client.session.prompt({
          sessionID: sessionId,
          parts: [{ type: 'text', text: this.continuationText(turn) }],
        })
        if (contResult.error) {
          log.warn({ issueId: issue.id, sessionId, turn }, 'continuation_turn_failed')
          return { sessionId, success: false, error: 'continuation_turn_failed', turnsCompleted }
        }

        turnsCompleted = turn
        this.reportActivity(issue.id, sessionId, 'turn_completed')

        // The agent's own "I am finished". Without it the loop has no exit but
        // max_turns: the issue stays In Progress for the whole run (symphony
        // owns that label and only moves it afterwards), so isActiveState is
        // true every time, and an agent that finished at turn 3 gets told
        // "the work is not finished" for every remaining turn.
        if (declaresCompletion(promptText(contResult.data), marker)) {
          log.info({ issueId: issue.id, turnsCompleted }, 'agent_reported_complete')
          stopReason = 'completed'
          break
        }
      }

      if (stopReason === 'max_turns') {
        // Not a failure, but not a finish either: the agent was interrupted
        // mid-task and whatever it had is about to be filed as reviewable.
        log.warn({ issueId: issue.id, turnsCompleted }, 'agent_run_hit_max_turns')
      }
      log.info({ issueId: issue.id, turnsCompleted, stopReason }, 'agent_run_completed')
      return { sessionId, success: true, turnsCompleted, stopReason }
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
  private continuationText(turn: number): string {
    const template = this.config.continuationGuidance || DEFAULT_CONTINUATION_GUIDANCE
    try {
      return renderContinuation(template, turn, this.config.maxTurns)
    } catch (err) {
      // A broken template in WORKFLOW.md must not strand a run that is already
      // under way: fall back rather than failing the turn.
      getLogger().warn({ error: String(err) }, 'continuation_guidance_render_failed')
      return renderContinuation(DEFAULT_CONTINUATION_GUIDANCE, turn, this.config.maxTurns)
    }
  }

  private async pumpSessionEvents(
    client: OpencodeClient, issueId: string, sessionId: string, signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.onActivity) return
    try {
      const { stream } = await client.v2.session.events({ sessionID: sessionId }, { signal })
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
