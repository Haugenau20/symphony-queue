import { watch, existsSync } from 'node:fs'
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
  onChange: (() => void) | null = null
  private watcher: ReturnType<typeof watch> | null = null

  constructor(wfPath: string | null) {
    this.path = wfPath ? resolve(wfPath) : resolve(process.cwd(), 'WORKFLOW.md')
    this.reload()
    try {
      const w = watch(this.path, (eventType) => {
        if (eventType === 'change') {
          getLogger().info('workflow_file_changed')
          this.reload()
          this.onChange?.()
        }
      })
      w.on('error', () => {
        getLogger().warn('file_watcher_error')
      })
      this.watcher = w
    } catch {
      getLogger().warn('file_watching_unavailable')
    }
  }

  private reload(): void {
    try {
      this.workflow = loadWorkflow(this.path)
      this.config = buildServiceConfig(this.workflow)
      this.lastError = null
    } catch (err) {
      this.workflow = null
      this.config = null
      this.lastError = err instanceof Error ? err.message : String(err)
      getLogger().error({ error: this.lastError }, 'workflow_reload_failed')
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
