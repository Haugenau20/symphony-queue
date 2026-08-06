import { spawn } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { WorkflowStore } from './workflow_store.js'
import { validateDispatchConfig } from './config.js'
import { configureLogging, getLogger } from './log.js'
import { SymphonyOrchestrator } from './orchestrator.js'
import { AgentRunner } from './agent_runner.js'
import { WorkspaceManager } from './workspace.js'
import { FileQueueTracker } from './tracker/file_queue.js'
import { GitLabTracker } from './tracker/gitlab.js'
import type { TrackerAdapter } from './tracker/base.js'
import { parseCliArgs, guardrailsBanner, usageMessage } from './cli.js'

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))

  if (args.unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${args.unknownFlags.join(', ')}\n`)
    console.error(usageMessage())
    process.exit(1)
  }

  if (!args.acknowledged) {
    console.error(guardrailsBanner())
    process.exit(1)
  }

  configureLogging({
    level: process.env.SYMPHONY_LOG_LEVEL || 'info',
    path: args.logsRoot ? `${args.logsRoot}/symphony.log` : undefined,
  })
  const log = getLogger()
  log.info('symphony_starting')

  const store = new WorkflowStore(args.workflowPath)
  if (store.workflow === null) {
    log.error({ error: store.lastError }, 'workflow_load_failed')
    process.exit(1)
  }
  const config = store.config!

  const errors = validateDispatchConfig(config)
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

  // One client per workspace, not one for all sessions: `directory` is
  // client-level config in the SDK, and each item has its own workspace. A
  // shared client roots every session at the server default — `/` on a fresh
  // OpenCode server — which is not where any of the work is. Clients are thin
  // wrappers over fetch, so building one per dispatch costs nothing.
  const clientFor = (directory: string | null) => createOpencodeClient({
    baseUrl: config.opencode.serverUrl,
    ...(directory ? { directory } : {}),
  })

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
    issueStateFetcher: (ids) => tracker.fetchIssueStatesByIds(ids),
    onActivity: (activity) => orch?.recordAgentActivity(activity),
    continuationGuidance: config.agent.continuationGuidance,
    completionMarker: config.agent.completionMarker,
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
