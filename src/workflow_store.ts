/**
 * Loads WORKFLOW.md once, at startup, and holds the parsed result.
 *
 * It used to watch the file and reload on change, and that is worth recording
 * rather than quietly deleting, because the watcher did not do what its name
 * and its log line said it did.
 *
 * `reload()` genuinely re-read the file and rebuilt the config — but nothing
 * ever read those fields again. `main.ts` takes `store.config` and
 * `store.workflow.promptTemplate` once, at construction, and passes the values
 * into `SymphonyOrchestrator` and `AgentRunner`, which hold them for the life
 * of the process. `onChange` was never assigned by anyone. So an edit to
 * WORKFLOW.md logged `workflow_file_changed`, refreshed a store nobody
 * consulted, and changed nothing about the running pipeline — while telling
 * whoever read the logs that it had.
 *
 * Two smaller problems sat underneath that one. The watch fired only on
 * `eventType === 'change'`, but editors that save by writing a temp file and
 * renaming over the target — vim, VS Code, `sed -i` — produce `'rename'` and
 * swap the inode, so the watcher was both ignoring the event and left holding
 * a file that no longer existed. And `reload()` blanked `workflow` and
 * `config` on a parse error, so a half-saved file would have replaced good
 * config with nothing, had anything been reading it.
 *
 * Reloading is a real feature and might be worth having: the prompt is already
 * consulted per dispatch (`orchestrator.ts` renders it at dispatch time, and
 * the review worker reads its override per session), so the value would land
 * on the next job without disturbing a run in flight. It needs a watcher that
 * survives an atomic save, a rule that a broken file keeps the last good
 * version, and prompt and `completion_marker` reloading together — they have
 * to agree, which is what `validateCompletionSignal` exists to enforce at
 * startup and nothing would enforce at runtime.
 *
 * Until that exists, config is read once and changing it means restarting the
 * process. Saying so plainly beats a log line that claims otherwise.
 */

import { resolve } from 'node:path'
import { loadWorkflow } from './workflow.js'
import { buildServiceConfig } from './config.js'
import type { WorkflowDefinition } from './models.js'
import type { ServiceConfig } from './config.js'
import { getLogger } from './log.js'

export class WorkflowStore {
  private path: string
  workflow: WorkflowDefinition | null = null
  config: ServiceConfig | null = null
  lastError: string | null = null

  constructor(wfPath: string | null) {
    this.path = wfPath ? resolve(wfPath) : resolve(process.cwd(), 'WORKFLOW.md')
    this.load()
  }

  private load(): void {
    try {
      this.workflow = loadWorkflow(this.path)
      this.config = buildServiceConfig(this.workflow)
      this.lastError = null
    } catch (err) {
      this.workflow = null
      this.config = null
      this.lastError = err instanceof Error ? err.message : String(err)
      getLogger().error({ error: this.lastError }, 'workflow_load_failed')
    }
  }
}
