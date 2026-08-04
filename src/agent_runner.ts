import type { Issue } from './models.js'
import { getLogger } from './log.js'
import type { OpencodeClient, PermissionRule } from '@opencode-ai/sdk/v2'

export interface AgentRunResult {
  sessionId: string | null
  success: boolean
  error?: string
  turnsCompleted: number
}

export interface AgentRunnerConfig {
  maxTurns: number
  issueStateFetcher: (issueIds: string[]) => Promise<Issue[]>
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
    try {
      const created = await this.client.session.create({
        title: `${issue.identifier}: ${issue.title}`,
        permission: PERMISSIONS,
      })
      sessionId = created.data!.id
      log.info({ issueId: issue.id, sessionId }, 'session_created')

      const result = await this.client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
      })
      if (result.error) {
        return { sessionId, success: false, error: 'initial_prompt_failed', turnsCompleted: 0 }
      }

      let turnsCompleted = 1
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
      }

      log.info({ issueId: issue.id, turnsCompleted }, 'agent_run_completed')
      return { sessionId, success: true, turnsCompleted }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ issueId: issue.id, error: message }, 'agent_run_failed')
      return { sessionId: null, success: false, error: message, turnsCompleted: 0 }
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
