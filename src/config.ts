import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { WorkflowDefinition } from './models.js'

function expandPath(value: string, workflowDir?: string): string {
  let expanded = value.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '')
  if (workflowDir && !expanded.startsWith('/') && !expanded.match(/^[A-Za-z]:\\/)) {
    expanded = join(workflowDir, expanded)
  }
  return expanded
}

const TrackerRawSchema = z.object({
  kind: z.string().default(''),
  /** file_queue: queue root. The six state directories live directly under it. */
  root: z.string().optional(),
  max_attempts: z.number().int().positive().default(5),
  active_states: z.array(z.string()).default(['Todo', 'In Progress']),
  terminal_states: z.array(z.string()).default(['Done', 'Cancelled']),

  /**
   * gitlab: instance base URL (no trailing slash, no /api/v4) and the project
   * to work. There is deliberately no token field — the token is read from the
   * environment, so no code path can pull a secret out of the workflow file.
   */
  base_url: z.string().optional(),
  project_id: z.string().optional(),
  /** Label namespace: `symphony` gives `symphony::todo`, `symphony::review`, … */
  label_prefix: z.string().default('symphony'),
  /** States that also close the GitLab issue. Moving off one reopens it. */
  closed_states: z.array(z.string()).default(['Done', 'Cancelled']),
})

const PollingRawSchema = z.object({
  interval_ms: z.number().int().positive().default(30000),
})

const WorkspaceRawSchema = z.object({
  root: z.string().optional(),
})

const HooksRawSchema = z.object({
  after_create: z.string().nullable().optional(),
  before_run: z.string().nullable().optional(),
  after_run: z.string().nullable().optional(),
  before_remove: z.string().nullable().optional(),
  timeout_ms: z.number().int().positive().default(60000),
})

const AgentRawSchema = z.object({
  max_concurrent_agents: z.number().int().positive().default(10),
  max_turns: z.number().int().positive().default(20),
  max_retry_backoff_ms: z.number().int().positive().default(300000),
  max_concurrent_agents_by_state: z.record(z.number().positive()).default({}),
  /**
   * Replaces the built-in nudge sent at the start of every turn after the
   * first. Liquid, with `turn`, `max_turns` and `turns_remaining` in scope.
   * The built-in cannot name the finishing step — "open a merge request" is
   * right for GitLab and meaningless for the file queue — so a workflow that
   * cares says it here.
   */
  continuation_guidance: z.string().nullable().default(null),
})

const OpenCodeRawSchema = z.object({
  server_url: z.string().default('http://localhost:4096'),
  server_start_command: z.string().nullable().default(null),
  stall_timeout_ms: z.number().int().default(300000),
  session_timeout_ms: z.number().int().positive().default(3600000),
})

export interface TrackerConfig {
  kind: string
  root: string | null
  maxAttempts: number
  activeStates: string[]
  terminalStates: string[]
  baseUrl: string | null
  projectId: string | null
  labelPrefix: string
  closedStates: string[]
}

export interface PollingConfig {
  intervalMs: number
}

export interface WorkspaceConfig {
  root: string
}

export interface HooksConfig {
  afterCreate: string | null
  beforeRun: string | null
  afterRun: string | null
  beforeRemove: string | null
  timeoutMs: number
}

export interface AgentConfig {
  maxConcurrentAgents: number
  maxTurns: number
  maxRetryBackoffMs: number
  maxConcurrentAgentsByState: Record<string, number>
  continuationGuidance: string | null
}

export interface OpenCodeConfig {
  serverUrl: string
  serverStartCommand: string | null
  stallTimeoutMs: number
  sessionTimeoutMs: number
}

export interface ServiceConfig {
  tracker: TrackerConfig
  polling: PollingConfig
  workspace: WorkspaceConfig
  hooks: HooksConfig
  agent: AgentConfig
  opencode: OpenCodeConfig
}

export function buildServiceConfig(wf: WorkflowDefinition, workflowDir?: string): ServiceConfig {
  const raw = wf.config

  const trackerRaw = TrackerRawSchema.parse(raw.tracker ?? {})
  const pollRaw = PollingRawSchema.parse(raw.polling ?? {})
  const wsRaw = WorkspaceRawSchema.parse(raw.workspace ?? {})
  const hRaw = HooksRawSchema.parse(raw.hooks ?? {})
  const aRaw = AgentRawSchema.parse(raw.agent ?? {})
  const oRaw = OpenCodeRawSchema.parse(raw.opencode ?? {})

  const wsRoot = wsRaw.root
    ? expandPath(wsRaw.root, workflowDir)
    : join(tmpdir(), 'symphony_workspaces')

  const perState: Record<string, number> = {}
  for (const [k, v] of Object.entries(aRaw.max_concurrent_agents_by_state)) {
    if (typeof v === 'number' && v > 0) {
      perState[k.toLowerCase()] = v
    }
  }

  return {
    tracker: {
      kind: trackerRaw.kind,
      root: trackerRaw.root ? expandPath(trackerRaw.root, workflowDir) : null,
      maxAttempts: trackerRaw.max_attempts,
      activeStates: [...trackerRaw.active_states],
      terminalStates: [...trackerRaw.terminal_states],
      baseUrl: trackerRaw.base_url ?? null,
      projectId: trackerRaw.project_id ?? null,
      labelPrefix: trackerRaw.label_prefix,
      closedStates: [...trackerRaw.closed_states],
    },
    polling: { intervalMs: pollRaw.interval_ms },
    workspace: { root: wsRoot },
    hooks: {
      afterCreate: hRaw.after_create ?? null,
      beforeRun: hRaw.before_run ?? null,
      afterRun: hRaw.after_run ?? null,
      beforeRemove: hRaw.before_remove ?? null,
      timeoutMs: hRaw.timeout_ms,
    },
    agent: {
      maxConcurrentAgents: aRaw.max_concurrent_agents,
      maxTurns: aRaw.max_turns,
      maxRetryBackoffMs: aRaw.max_retry_backoff_ms,
      maxConcurrentAgentsByState: perState,
      continuationGuidance: aRaw.continuation_guidance ?? null,
    },
    opencode: {
      serverUrl: oRaw.server_url,
      serverStartCommand: oRaw.server_start_command,
      stallTimeoutMs: oRaw.stall_timeout_ms,
      sessionTimeoutMs: oRaw.session_timeout_ms,
    },
  }
}

export function parseAndValidateConfig(wf: WorkflowDefinition, workflowDir?: string): { config: ServiceConfig; errors: string[] } {
  const config = buildServiceConfig(wf, workflowDir)
  return { config, errors: validateDispatchConfig(config) }
}

export const SUPPORTED_TRACKER_KINDS = ['file_queue', 'gitlab'] as const

type SupportedTrackerKind = (typeof SUPPORTED_TRACKER_KINDS)[number]

export function validateDispatchConfig(cfg: ServiceConfig): string[] {
  const errors: string[] = []
  if (!cfg.tracker.kind) {
    errors.push('tracker.kind is required')
  } else if (!SUPPORTED_TRACKER_KINDS.includes(cfg.tracker.kind as SupportedTrackerKind)) {
    errors.push(`unsupported tracker.kind: ${cfg.tracker.kind}`)
  }
  if (cfg.tracker.activeStates.length === 0) {
    errors.push('tracker.active_states must not be empty')
  }
  if (cfg.tracker.kind === 'file_queue' && !cfg.tracker.root) {
    errors.push('tracker.root is required for the file_queue tracker')
  }
  if (cfg.tracker.kind === 'gitlab') {
    if (!cfg.tracker.baseUrl) errors.push('tracker.base_url is required for the gitlab tracker')
    if (!cfg.tracker.projectId) errors.push('tracker.project_id is required for the gitlab tracker')
    // Checked here rather than at construction so a missing token surfaces in
    // the same preflight as every other config error, before any dispatch.
    if (!process.env.SYMPHONY_GITLAB_TOKEN) {
      errors.push('SYMPHONY_GITLAB_TOKEN must be set in the environment for the gitlab tracker')
    }
  }
  return errors
}
