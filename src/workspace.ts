import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sanitizeWorkspaceKey, checkContainment } from './path_safety.js'
import { execHook } from './hooks.js'
import type { Workspace } from './models.js'
import { getLogger } from './log.js'

export interface WorkspaceManagerConfig {
  root: string
  afterCreate?: string | null
  beforeRun?: string | null
  afterRun?: string | null
  beforeRemove?: string | null
  hookTimeoutMs?: number
}

export class WorkspaceManager {
  constructor(private config: WorkspaceManagerConfig) {}

  createForIssue(identifier: string, workspaceRootOverride?: string): Workspace {
    const root = workspaceRootOverride ?? this.config.root
    const key = sanitizeWorkspaceKey(identifier)
    const wsPath = resolve(join(root, key))
    checkContainment(wsPath, root)

    const exists = existsSync(wsPath)
    if (!exists) {
      mkdirSync(wsPath, { recursive: true })
    }

    const ws: Workspace = { path: wsPath, workspaceKey: key, createdNow: !exists }

    return ws
  }

  async runAfterCreate(ws: Workspace): Promise<void> {
    if (ws.createdNow && this.config.afterCreate) {
      const result = await execHook(this.config.afterCreate, ws.path, this.config.hookTimeoutMs ?? 60000)
      if (!result.success) throw new Error(`after_create hook failed: ${result.error}`)
    }
  }

  async runBeforeRun(ws: Workspace): Promise<void> {
    if (this.config.beforeRun) {
      const result = await execHook(this.config.beforeRun, ws.path, this.config.hookTimeoutMs ?? 60000)
      if (!result.success) throw new Error(`before_run hook failed: ${result.error}`)
    }
  }

  async runAfterRun(ws: Workspace): Promise<void> {
    if (this.config.afterRun) {
      try {
        await execHook(this.config.afterRun, ws.path, this.config.hookTimeoutMs ?? 60000)
      } catch { /* logged but ignored */ }
    }
  }

  removeForIssue(identifier: string): void {
    const root = this.config.root
    const key = sanitizeWorkspaceKey(identifier)
    const wsPath = resolve(join(root, key))
    if (!existsSync(wsPath)) return
    if (this.config.beforeRemove) {
      try { execHook(this.config.beforeRemove, wsPath, this.config.hookTimeoutMs ?? 60000) } catch { /* ignored */ }
    }
    rmSync(wsPath, { recursive: true, force: true })
  }
}
