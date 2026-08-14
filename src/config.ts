import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { WorkflowDefinition } from './models.js'
import { REVIEW_PERMISSIONS } from './review/worker.js'

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
  /**
   * The line an agent emits to declare itself finished, ending the run before
   * max_turns. Empty string disables the check.
   *
   * Without it the turn loop has no exit but exhaustion: symphony owns the
   * item's state and does not move it until the run is over, so the "is the
   * item still active?" test is true on every iteration and an agent that
   * finished early is prompted to keep going until the turns are gone.
   */
  completion_marker: z.string().default('SYMPHONY_DONE'),
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
  completionMarker: string
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
      completionMarker: aRaw.completion_marker,
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
  return {
    config,
    errors: [
      ...validateDispatchConfig(config),
      ...validateCompletionSignal(config, wf.promptTemplate),
    ],
  }
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

/**
 * A `completion_marker` the prompt never mentions is a marker the agent is
 * never asked for. `declaresCompletion` is then false on every turn and the
 * loop has no exit but exhaustion — symphony owns the issue's label and does
 * not move it mid-run, so the "is it still active?" test is true every time.
 * The run does its work, opens its merge request, and then spends every
 * remaining turn being told to keep going while holding a live credential.
 *
 * A hard error rather than a warning, because the failure is invisible from
 * outside: the runs succeed, the issues reach review, the merge requests are
 * correct. Only `stopReason` in the container log says the turns were burned,
 * and nothing at all says why. A workflow file that fell behind its example is
 * enough to cause it, and the symptom looks like a slow or clumsy model.
 *
 * Checkable precisely because the mention cannot be indirect: `renderPrompt`
 * and `renderContinuation` both run Liquid with `strictVariables: true`, and
 * neither context carries the marker — a template referring to it would throw
 * rather than interpolate. A literal substring is its only route to the agent.
 *
 * Opting out stays explicit: `completion_marker: ""` disables early exit and
 * accepts that every run spends its full budget.
 */
export function validateCompletionSignal(cfg: ServiceConfig, promptTemplate: string): string[] {
  const marker = cfg.agent.completionMarker
  if (!marker) return []

  const mentioned = promptTemplate.includes(marker)
    || (cfg.agent.continuationGuidance?.includes(marker) ?? false)
  if (mentioned) return []

  return [
    `agent.completion_marker is ${JSON.stringify(marker)} but neither the prompt `
    + 'body nor agent.continuation_guidance mentions it. The agent is never asked '
    + 'to emit it, so no run can end early and every run will use all '
    + `${cfg.agent.maxTurns} turns of agent.max_turns. Either tell the agent to end `
    + `its reply with ${marker} on a line of its own, or set completion_marker: "" `
    + 'to accept that runs always use every turn.',
  ]
}

// --- review pipeline configuration -------------------------------------------
//
// REVIEW.md is a second, independent config file (design §13): same
// front-matter-plus-prompt shape as WORKFLOW.md, parsed by the same loader,
// but describing the merge-request review pipeline instead of issue dispatch.
// A review-only deployment ships REVIEW.md and NO WORKFLOW.md at all, which is
// why this lives beside `buildServiceConfig` rather than inside it.

const ReviewRawSchema = z.object({
  base_url: z.string().default(''),
  /** Whole-group coverage: one API call per poll regardless of project count. */
  group_id: z.string().optional(),
  /** Staged rollout: an explicit list, so adding a repository is a deliberate act. */
  projects: z.array(z.string()).default([]),
  poll_interval_ms: z.number().int().positive().default(60000),
  include_drafts: z.boolean().default(false),
  skip_forks: z.boolean().default(true),
  rereview_on_new_head: z.boolean().default(true),
  max_attempts: z.number().int().positive().default(3),
  exclude_paths: z.array(z.string()).default([]),
  max_diff_bytes: z.number().int().positive().default(400000),
  /**
   * Phase 2. GitLab flags generated files itself (`generated_file`), which is a
   * better answer than guessing at them with exclude_paths patterns. Default ON:
   * a generated file's diff is noise the reviewer should not spend a chunk on.
   */
  exclude_generated: z.boolean().default(true),
  /**
   * Soft per-chunk diff budget. A diff larger than this is split into batches
   * and reviewed in sequence rather than refused — phase 1 declined outright,
   * because a partial review presented as a whole one is worse than an honest
   * refusal, and chunking is what makes the honest refusal unnecessary.
   * Defaults to max_diff_bytes so a deployment that only ever set that keeps
   * behaving the way it did.
   */
  max_chunk_bytes: z.number().int().positive().optional(),
  /** Hard ceiling on batches. Beyond it the review is refused, never truncated. */
  max_chunks: z.number().int().positive().default(20),
  /**
   * Budget for the FULL FILE CONTENTS fetched into the sandbox for context.
   * Separate from the chunk budget on purpose: chunking bounds the diff, and
   * nothing would otherwise bound the context, so a one-line change to a huge
   * file would write the whole file into a sandbox the agent container shares.
   * Exhausting this is not a refusal — the diff is still reviewed in full.
   */
  max_context_bytes: z.number().int().positive().optional(),
  /**
   * The self-critique pass: a second, independent agent session that re-reads
   * the first pass's findings and drops the weak ones before publication.
   * Default ON. Reviewer noise is the only failure mode in this design that
   * costs anything, and this is the direct attack on it. A critique that cannot
   * run never fails the review — the note says it did not run.
   */
  critique: z.boolean().default(true),
  /** Ceiling on the critique session. Generous: it re-reads the diff it is judging. */
  critique_timeout_ms: z.number().int().positive().default(600_000),
  /**
   * Optional read-only shallow checkout at the pinned head SHA, for context
   * beyond the changed files. Default OFF: it costs a network fetch and a
   * second copy of the working tree per review. The clone is done by trusted
   * code and `.git` is deleted before the agent starts, so the sandbox still
   * contains no git repository.
   */
  checkout: z.boolean().default(false),
  per_project_max_in_flight: z.number().int().positive().default(1),
  /**
   * Leave the sandbox on disk when a review does not produce findings, so it can
   * be inspected. A diagnostic, not a normal setting: they accumulate, and they
   * contain the merge request's own content. Also settable per-run with
   * SYMPHONY_REVIEW_KEEP_FAILED_WORKSPACES=1, which is the form you want when
   * chasing a failure on a running deployment.
   */
  keep_failed_workspaces: z.boolean().default(false),
  max_concurrent_reviews: z.number().int().positive().default(2),
  reserved_review_slots: z.number().int().nonnegative().default(1),
})

const ReviewAgentRawSchema = z.object({
  max_turns: z.number().int().positive().default(10),
  /**
   * Ceiling on one agent run. Review mode originally passed no timeout at all,
   * and a hung OpenCode session held its slot for ten hours without so much as
   * a warning — there is no stall detector on this lane to catch it either.
   * 15 minutes is generous for reading one diff.
   */
  session_timeout_ms: z.number().int().positive().default(900_000),
  completion_marker: z.string().default('SYMPHONY_REVIEW_DONE'),
  /**
   * Documentation of what the code already enforces, not a control surface.
   * `REVIEW_PERMISSIONS` in review/worker.ts is the enforcement point and is
   * deliberately not configurable — a config file that could grant the review
   * agent `bash` or `webfetch` would dissolve the boundary the whole design
   * rests on. Validation below rejects any line that disagrees with what is
   * actually enforced, in either direction, so the block behaves as a checked
   * assertion rather than decoration.
   */
  permissions: z.record(z.string()).default({}),
})

/**
 * What the review agent's permissions actually are, derived from the single
 * enforcement point rather than restated here. A second hand-maintained list
 * would drift from the real one, and the whole value of validating this block
 * is that it tells the truth about what will run.
 */
/** `1`, `true` or `yes`, case-insensitive. Anything else — including unset — is false. */
function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

function enforcedReviewPermissions(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rule of REVIEW_PERMISSIONS) map[rule.permission] = rule.action
  return map
}

export interface ReviewConfig {
  baseUrl: string
  groupId: string | null
  projects: string[]
  pollIntervalMs: number
  includeDrafts: boolean
  skipForks: boolean
  rereviewOnNewHead: boolean
  maxAttempts: number
  excludePaths: string[]
  maxDiffBytes: number
  excludeGenerated: boolean
  maxChunkBytes: number
  maxChunks: number
  maxContextBytes: number
  critique: boolean
  critiqueTimeoutMs: number
  checkout: boolean
  perProjectMaxInFlight: number
  keepFailedWorkspaces: boolean
  maxConcurrentReviews: number
  reservedReviewSlots: number
  agent: {
    maxTurns: number
    completionMarker: string
    sessionTimeoutMs: number
    declaredPermissions: Record<string, string>
  }
  /** From the environment, never the file — these are deployment paths, not workflow content. */
  storeRoot: string
  workspacesRoot: string
}

export function buildReviewConfig(wf: WorkflowDefinition, env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const root = wf.config as Record<string, unknown>
  const rRaw = ReviewRawSchema.parse((root.review as object) ?? {})
  const aRaw = ReviewAgentRawSchema.parse((root.agent as object) ?? {})

  return {
    baseUrl: rRaw.base_url,
    groupId: rRaw.group_id ?? null,
    projects: rRaw.projects,
    pollIntervalMs: rRaw.poll_interval_ms,
    includeDrafts: rRaw.include_drafts,
    skipForks: rRaw.skip_forks,
    rereviewOnNewHead: rRaw.rereview_on_new_head,
    maxAttempts: rRaw.max_attempts,
    excludePaths: rRaw.exclude_paths,
    maxDiffBytes: rRaw.max_diff_bytes,
    excludeGenerated: rRaw.exclude_generated,
    // Both fall back to max_diff_bytes, so a phase 1 config keeps its meaning.
    maxChunkBytes: rRaw.max_chunk_bytes ?? rRaw.max_diff_bytes,
    maxContextBytes: rRaw.max_context_bytes ?? rRaw.max_diff_bytes,
    maxChunks: rRaw.max_chunks,
    critique: rRaw.critique,
    critiqueTimeoutMs: rRaw.critique_timeout_ms,
    checkout: rRaw.checkout,
    perProjectMaxInFlight: rRaw.per_project_max_in_flight,
    // The environment wins, so this can be turned on for one restart without
    // editing (and later forgetting to un-edit) a config file.
    keepFailedWorkspaces: truthyEnv(env.SYMPHONY_REVIEW_KEEP_FAILED_WORKSPACES) || rRaw.keep_failed_workspaces,
    maxConcurrentReviews: rRaw.max_concurrent_reviews,
    reservedReviewSlots: rRaw.reserved_review_slots,
    agent: {
      maxTurns: aRaw.max_turns,
      completionMarker: aRaw.completion_marker,
      sessionTimeoutMs: aRaw.session_timeout_ms,
      declaredPermissions: aRaw.permissions,
    },
    storeRoot: env.SYMPHONY_REVIEW_STORE_ROOT ?? '',
    workspacesRoot: env.SYMPHONY_REVIEW_WORKSPACES_ROOT ?? '',
  }
}

/**
 * Every way a review deployment can be misconfigured such that it would start
 * and then do something unintended. Checked before anything is dispatched, for
 * the same reason `validateDispatchConfig` is: an unattended misconfiguration
 * surfaces hours later as strange behaviour, not as an error at a prompt.
 */
export function validateReviewConfig(cfg: ReviewConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = []

  if (!cfg.baseUrl) errors.push('review.base_url is required')
  if (!cfg.groupId && cfg.projects.length === 0) {
    errors.push('review.group_id or a non-empty review.projects list is required — otherwise the reviewer watches nothing')
  }

  // Same rule as the tracker token (DESIGN.md §10): from the environment only.
  // There is deliberately no config key that could hold it.
  if (!env.SYMPHONY_REVIEW_GITLAB_TOKEN) {
    errors.push('SYMPHONY_REVIEW_GITLAB_TOKEN must be set in the environment for the review pipeline')
  }

  if (!cfg.storeRoot) errors.push('SYMPHONY_REVIEW_STORE_ROOT must be set in the environment')
  if (!cfg.workspacesRoot) errors.push('SYMPHONY_REVIEW_WORKSPACES_ROOT must be set in the environment')
  if (cfg.storeRoot && cfg.workspacesRoot && cfg.storeRoot === cfg.workspacesRoot) {
    errors.push('SYMPHONY_REVIEW_STORE_ROOT and SYMPHONY_REVIEW_WORKSPACES_ROOT must differ — durable job state must not share a directory with disposable sandboxes')
  }

  if (cfg.reservedReviewSlots > cfg.maxConcurrentReviews) {
    errors.push('review.reserved_review_slots cannot exceed review.max_concurrent_reviews')
  }

  // The permissions block is an assertion about the sandbox, not a control.
  // Refusing to start on a mismatch is the point: a REVIEW.md that *believes*
  // it granted the agent bash — or that claims the agent cannot write, when
  // writing FINDINGS.json is the only way it produces a review at all — is a
  // startup failure rather than a line that quietly misleads its next reader.
  const enforced = enforcedReviewPermissions()
  for (const [name, declared] of Object.entries(cfg.agent.declaredPermissions)) {
    const actual = enforced[name]
    if (actual === undefined) {
      errors.push(
        `agent.permissions.${name} is not a permission this pipeline sets. `
        + `Known: ${Object.keys(enforced).sort().join(', ')}.`,
      )
    } else if (declared !== actual) {
      errors.push(
        `agent.permissions.${name} is "${declared}", but the review agent always sets it to "${actual}". `
        + 'This block documents the sandbox; it cannot change it. Correct the line or remove it.',
      )
    }
  }

  return errors
}
