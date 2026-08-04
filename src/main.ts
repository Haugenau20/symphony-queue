import { spawn } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { WorkflowStore } from './workflow_store.js'
import { validateDispatchConfig } from './config.js'
import { configureLogging, getLogger } from './log.js'
import { SymphonyOrchestrator } from './orchestrator.js'
import { AgentRunner } from './agent_runner.js'
import { WorkspaceManager } from './workspace.js'
import { MemoryTracker } from './tracker/memory.js'
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

  // Phase 2 replaces this with FileQueueTracker built from the queue config.
  const tracker: TrackerAdapter = new MemoryTracker(config.tracker.activeStates)

  const wsManager = new WorkspaceManager({
    root: config.workspace.root, afterCreate: config.hooks.afterCreate, beforeRun: config.hooks.beforeRun,
    afterRun: config.hooks.afterRun, beforeRemove: config.hooks.beforeRemove, hookTimeoutMs: config.hooks.timeoutMs,
  })

  const client = createOpencodeClient({ baseUrl: config.opencode.serverUrl })

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

  const agentRunner = new AgentRunner(client, {
    maxTurns: config.agent.maxTurns,
    issueStateFetcher: (ids) => tracker.fetchIssueStatesByIds(ids),
  })
  const orch = new SymphonyOrchestrator({
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
