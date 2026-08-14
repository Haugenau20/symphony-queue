import { spawn } from 'node:child_process'
import { makeOpencodeClientFactory } from './opencode_client.js'
import { WorkflowStore } from './workflow_store.js'
import { validateCompletionSignal, validateDispatchConfig } from './config.js'
import { configureLogging, getLogger } from './log.js'
import { SymphonyOrchestrator } from './orchestrator.js'
import { AgentRunner } from './agent_runner.js'
import { WorkspaceManager } from './workspace.js'
import { FileQueueTracker } from './tracker/file_queue.js'
import { GitLabTracker } from './tracker/gitlab.js'
import type { TrackerAdapter } from './tracker/base.js'
import { parseCliArgs, guardrailsBanner, usageMessage } from './cli.js'
import { loadWorkflow } from './workflow.js'
import { buildReviewConfig, validateReviewConfig } from './config.js'
import { GitLabMergeRequestClient } from './review/gitlab_mr.js'
import { DirectoryReviewStore } from './review/store.js'
import { ReviewWorker } from './review/worker.js'
import { AgentFindingsCritic } from './review/critique.js'
import { GitShallowCheckout } from './review/checkout.js'
import { ReviewPublisher } from './review/publisher.js'
import { ReviewJobRunner } from './review/job_runner.js'
import { ReviewController } from './review/controller.js'
import { ConcurrencyGate } from './concurrency.js'

/**
 * The review pipeline: poll a GitLab group for open merge requests, review one
 * exact head SHA in a disposable sandbox, publish one summary note.
 *
 * A separate entry point rather than a branch inside the orchestrator, because
 * a review deployment has no tracker, no issue state machine and no WORKFLOW.md
 * at all — the two pipelines share the agent runner and nothing else. The
 * launcher runs this in its own container with its own credential
 * (SYMPHONY_MODE=review, docker-compose.review.yml).
 */
async function runReviewMode(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const log = getLogger()

  // The launcher fixes this at /config/REVIEW.md; a positional argument wins so
  // the same binary can be pointed at a file by hand for a first manual run.
  const reviewPath = args.workflowPath ?? process.env.SYMPHONY_REVIEW_WORKFLOW ?? '/config/REVIEW.md'

  let wf
  try {
    wf = loadWorkflow(reviewPath)
  } catch (err) {
    log.error({ error: String(err), path: reviewPath }, 'review_config_load_failed')
    process.exit(1)
  }

  const config = buildReviewConfig(wf)
  const errors = validateReviewConfig(config)
  if (errors.length > 0) {
    for (const err of errors) log.error({ error: err }, 'review_config_validation_failed')
    process.exit(1)
  }

  log.info(
    {
      // Never the token, and never the note bodies. Counts and identifiers only.
      baseUrl: config.baseUrl,
      group: config.groupId,
      projectCount: config.projects.length,
      pollIntervalMs: config.pollIntervalMs,
      includeDrafts: config.includeDrafts,
      // Phase 2 behaviour, in the one line an operator reads first. "Why did
      // the note say the critique did not run" should be answerable from
      // startup, not from reading the config file over someone's shoulder.
      excludeGenerated: config.excludeGenerated,
      critique: config.critique,
      checkout: config.checkout,
      maxChunkBytes: config.maxChunkBytes,
      maxChunks: config.maxChunks,
      maxContextBytes: config.maxContextBytes,
    },
    'review_config_loaded',
  )

  const client = new GitLabMergeRequestClient({
    baseUrl: config.baseUrl,
    // From the environment, never the file — there is no config key that could hold it.
    token: process.env.SYMPHONY_REVIEW_GITLAB_TOKEN!,
    ...(config.groupId ? { group: config.groupId } : { projects: config.projects }),
  })

  const store = new DirectoryReviewStore({
    root: config.storeRoot,
    maxAttempts: config.maxAttempts,
    createIfMissing: true,
  })

  const wsManager = new WorkspaceManager({ root: config.workspacesRoot })
  const clientFor = makeOpencodeClientFactory(reviewOpencodeUrl())

  const agentRunner = new AgentRunner(clientFor, {
    maxTurns: config.agent.maxTurns,
    completionMarker: config.agent.completionMarker,
    // Not optional in practice: without it the runner applies no deadline to
    // session.prompt, and this lane has no stall detector to notice. A hung
    // session otherwise holds its concurrency slot indefinitely.
    sessionTimeoutMs: config.agent.sessionTimeoutMs,
  })

  // The self-critique pass runs as its OWN agent session, deliberately: a model
  // asked to disown findings still sitting in its context window defends them,
  // while one meeting them cold can disagree. It shares the runner (same
  // OpenCode server, same permission set) and holds no GitLab client of any
  // kind — the type it takes makes reaching GitLab a compile error.
  const critic = config.critique
    ? new AgentFindingsCritic({ agentRunner, timeoutMs: config.critiqueTimeoutMs })
    : null

  // Optional wider-context checkout. TRUSTED code does the clone, because it is
  // the only side holding the token and the egress; `.git` is deleted before the
  // agent session exists, so the sandbox still contains no git repository and
  // the reviewing agent still has nothing to push with.
  const checkout = config.checkout
    ? new GitShallowCheckout({
        baseUrl: config.baseUrl,
        token: process.env.SYMPHONY_REVIEW_GITLAB_TOKEN!,
        sandboxRoot: config.workspacesRoot,
      })
    : null

  const worker = new ReviewWorker({
    mrClient: client,
    agentRunner,
    workspaceManager: wsManager,
    excludePaths: config.excludePaths,
    maxDiffBytes: config.maxDiffBytes,
    excludeGenerated: config.excludeGenerated,
    maxChunkBytes: config.maxChunkBytes,
    maxChunks: config.maxChunks,
    maxContextBytes: config.maxContextBytes,
    ...(critic ? { critic } : {}),
    ...(checkout ? { checkout, enableCheckout: true } : {}),
    keepFailedWorkspaces: config.keepFailedWorkspaces,
    // Slightly beyond the runner's own deadline, so the runner's cleaner error
    // normally wins and this stays a backstop rather than the usual path.
    agentTimeoutMs: config.agent.sessionTimeoutMs + 60_000,
    // REVIEW.md's body is the prompt, exactly as WORKFLOW.md's is. It is
    // TRUSTED operator text and is passed through verbatim — deliberately not
    // rendered against merge-request fields, so no MR-authored string can ever
    // reach the instruction region. MR title and description reach the agent
    // only inside MR.md's fenced UNTRUSTED block.
    ...(wf.promptTemplate.trim() ? { promptOverride: wf.promptTemplate } : {}),
  })

  const publisher = new ReviewPublisher({ mrClient: client })

  const jobRunner = new ReviewJobRunner({
    worker,
    publisher,
    store,
    maxAttempts: config.maxAttempts,
  })

  const controller = new ReviewController({
    store,
    client,
    worker: jobRunner,
    gate: new ConcurrencyGate(config.maxConcurrentReviews),
    pollIntervalMs: config.pollIntervalMs,
    includeDrafts: config.includeDrafts,
    perProjectMaxInFlight: config.perProjectMaxInFlight,
    laneMax: config.maxConcurrentReviews,
    laneReserved: config.reservedReviewSlots,
  })

  const shutdown = () => {
    log.info('shutdown_requested')
    controller.stop()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log.info('review_started')
  await controller.run()
  log.info('review_stopped')
  process.exit(0)
}

/** The OpenCode server URL for review mode, which has no WORKFLOW.md to read it from. */
function reviewOpencodeUrl(): string {
  return process.env.SYMPHONY_OPENCODE_URL || 'http://opencode-review:4096'
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))

  if (args.unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${args.unknownFlags.join(', ')}\n`)
    console.error(usageMessage())
    process.exit(1)
  }

  const reviewMode = process.env.SYMPHONY_MODE === 'review'

  // The guardrails acknowledgement exists because the implementation agent runs
  // with bash and webfetch GRANTED, on a real checkout, holding a token that can
  // push. The reviewer has none of that: no shell, no egress, no credential, and
  // a synthetic sandbox instead of a checkout. Demanding the same
  // acknowledgement would be asking the operator to agree to something that is
  // not happening, so review mode states its actual posture in the log instead.
  if (!reviewMode && !args.acknowledged) {
    console.error(guardrailsBanner())
    process.exit(1)
  }

  configureLogging({
    level: process.env.SYMPHONY_LOG_LEVEL || 'info',
    path: args.logsRoot ? `${args.logsRoot}/symphony.log` : undefined,
  })
  const log = getLogger()

  if (reviewMode) {
    log.info(
      {
        // No shell, no egress, no credential. The sandbox itself is what the
        // agent is confined to, via the container's OPENCODE_EXTRA_ALLOWED_DIRS.
        permissions: 'bash and webfetch denied; reads and writes confined to the sandbox',
        agentHoldsToken: false,
      },
      'review_mode_starting',
    )
    await runReviewMode(args)
    return
  }

  log.info('symphony_starting')

  const store = new WorkflowStore(args.workflowPath)
  if (store.workflow === null) {
    log.error({ error: store.lastError }, 'workflow_load_failed')
    process.exit(1)
  }
  const config = store.config!

  const errors = [
    ...validateDispatchConfig(config),
    // Needs the prompt body, which `config` alone does not carry.
    ...validateCompletionSignal(config, store.workflow.promptTemplate),
  ]
  if (errors.length > 0) {
    for (const err of errors) log.error({ error: err }, 'config_validation_failed')
    process.exit(1)
  }

  log.info({ trackerKind: config.tracker.kind }, 'symphony_config_loaded')

  let tracker: TrackerAdapter
  try {
    tracker = config.tracker.kind === 'gitlab'
      ? new GitLabTracker({
          baseUrl: config.tracker.baseUrl!,
          projectId: config.tracker.projectId!,
          // From the environment, never the workflow file — there is no code
          // path by which a secret enters the config.
          token: process.env.SYMPHONY_GITLAB_TOKEN!,
          labelPrefix: config.tracker.labelPrefix,
          closedStates: config.tracker.closedStates,
        })
      : new FileQueueTracker({
          root: config.tracker.root!,
          maxAttempts: config.tracker.maxAttempts,
          maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
        })
  } catch (err) {
    log.error({ error: String(err), trackerKind: config.tracker.kind }, 'tracker_init_failed')
    process.exit(1)
  }

  if (tracker instanceof FileQueueTracker) {
    const recoverable = await tracker.fetchRecoverableIssues()
    if (recoverable.length > 0) {
      // SPEC §14.3: no scheduler state survives a restart, but whatever is still
      // sitting in in-progress/ is exactly the set that was live. v1 simply lets
      // the ordinary candidate path re-dispatch them.
      log.info({ count: recoverable.length, ids: recoverable.map((i) => i.id) }, 'queue_recovery_set')
    }
  }

  const wsManager = new WorkspaceManager({
    root: config.workspace.root, afterCreate: config.hooks.afterCreate, beforeRun: config.hooks.beforeRun,
    afterRun: config.hooks.afterRun, beforeRemove: config.hooks.beforeRemove, hookTimeoutMs: config.hooks.timeoutMs,
  })

  // Per-workspace clients over a shared, timeout-free dispatcher. Both halves
  // of that matter and both are explained in ./opencode_client.ts.
  const clientFor = makeOpencodeClientFactory(config.opencode.serverUrl)

  if (config.opencode.serverStartCommand) {
    const child = spawn(config.opencode.serverStartCommand, { stdio: 'inherit', shell: true, cwd: process.cwd(), detached: true })
    child.unref()
    await new Promise((r) => setTimeout(r, 2000))
  }

  try {
    const health = await fetch(`${config.opencode.serverUrl}/global/health`, { signal: AbortSignal.timeout(5000) })
    if (!health.ok) throw new Error(`Health check returned ${health.status}`)
    log.info({ serverUrl: config.opencode.serverUrl }, 'opencode_server_connected')
  } catch (err) {
    log.warn({ error: String(err), serverUrl: config.opencode.serverUrl }, 'opencode_health_check_failed')
    log.warn('Proceeding despite health check failure; first session request will confirm connectivity')
  }

  // The runner reports agent activity to the orchestrator and the orchestrator
  // dispatches through the runner, so one of the two references has to be
  // late-bound. A closure over `orch` is the smaller lie than a setter.
  let orch: SymphonyOrchestrator | undefined
  const agentRunner = new AgentRunner(clientFor, {
    maxTurns: config.agent.maxTurns,
    onActivity: (activity) => orch?.recordAgentActivity(activity),
    continuationGuidance: config.agent.continuationGuidance,
    completionMarker: config.agent.completionMarker,
    sessionTimeoutMs: config.opencode.sessionTimeoutMs,
  })
  orch = new SymphonyOrchestrator({
    tracker, agentRunner, workspaceManager: wsManager,
    promptTemplate: store.workflow?.promptTemplate,
    maxConcurrent: config.agent.maxConcurrentAgents, pollIntervalMs: config.polling.intervalMs,
    activeStates: config.tracker.activeStates, terminalStates: config.tracker.terminalStates,
    maxTurns: config.agent.maxTurns, maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
    stallTimeoutMs: config.opencode.stallTimeoutMs, maxConcurrentByState: config.agent.maxConcurrentAgentsByState,
  })

  const shutdown = () => {
    log.info('shutdown_requested')
    orch.stop()
    store.close()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log.info('symphony_started')
  await orch.run()
  log.info('symphony_stopped')
  process.exit(0)
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
