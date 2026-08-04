import { existsSync, mkdirSync, statSync } from 'node:fs'
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import { z } from 'zod'
import { checkContainment } from '../path_safety.js'
import { getLogger } from '../log.js'
import { backoffDelay } from '../orchestrator.js'
import type { BlockerRef, Issue } from '../models.js'
import type { TrackerAdapter } from './base.js'

/**
 * The directory a file sits in *is* its state. There is deliberately no
 * `state:` field in front matter: two sources of truth for one fact is the bug.
 */
export const QUEUE_DIRECTORIES = {
  'todo': 'Todo',
  'in-progress': 'In Progress',
  'review': 'In Review',
  'done': 'Done',
  'failed': 'Failed',
  'cancelled': 'Cancelled',
} as const

export type QueueDirectory = keyof typeof QUEUE_DIRECTORIES
export type QueueState = (typeof QUEUE_DIRECTORIES)[QueueDirectory]

export const STATE_TO_DIRECTORY = Object.fromEntries(
  Object.entries(QUEUE_DIRECTORIES).map(([dir, state]) => [state, dir]),
) as Record<string, QueueDirectory>

/** Ordered so that scans and duplicate-id resolution are deterministic. */
const DIRECTORY_ORDER = Object.keys(QUEUE_DIRECTORIES) as QueueDirectory[]

const CANDIDATE_DIRECTORIES: QueueDirectory[] = ['todo', 'in-progress']
const RECOVERY_DIRECTORY: QueueDirectory = 'in-progress'
const FAILED_DIRECTORY: QueueDirectory = 'failed'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_ID_LENGTH = 128

/** Conservative git-ref shape. A value that fails this is dropped, not trusted. */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const JIRA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidQueueId(id: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id)
}

// --- front matter -----------------------------------------------------------

export interface QueueItemFrontMatter {
  id: string
  title: string
  priority: number | null
  labels: string[]
  blockedBy: string[]
  branch: string | null
  jira: string | null
  attempts: number
  nextRetryAt: Date | null
  sessionId: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export interface ParsedQueueItem {
  frontMatter: QueueItemFrontMatter
  body: string
  /** True when the file carried a `state:` key, which is ignored on purpose. */
  hadStateField: boolean
}

const nullableDate = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid' : v
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? 'invalid' : d
  }
  return 'invalid'
}, z.date().nullable())

const nullableText = z.string().nullable().optional()

/**
 * Every field is validated, and unknown keys are dropped rather than carried
 * through: the agent writes its workpad into this same file, so front matter is
 * attacker-influenced by construction.
 */
const FrontMatterSchema = z.object({
  id: z.string().refine(isValidQueueId, { message: 'id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$' }),
  title: z.string().min(1),
  priority: z.number().int().nullable().optional(),
  labels: z.array(z.string()).optional(),
  blocked_by: z.array(z.string()).optional(),
  branch: nullableText,
  jira: nullableText,
  attempts: z.number().int().min(0).optional(),
  next_retry_at: nullableDate,
  session_id: nullableText,
  created_at: nullableDate,
  updated_at: nullableDate,
})

function normalizeLabels(labels: string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const raw of labels ?? []) {
    const label = raw.trim().toLowerCase()
    if (label) seen.add(label)
  }
  return [...seen]
}

/** A value that fails its shape check is dropped, not passed downstream. */
function guarded(value: string | null | undefined, pattern: RegExp): string | null {
  if (typeof value !== 'string' || !pattern.test(value)) return null
  return value
}

function splitFrontMatter(raw: string): { yamlText: string; body: string } {
  if (!raw.startsWith('---')) throw new Error('missing YAML front matter')
  const rest = raw.slice(3)
  const end = rest.indexOf('\n---')
  if (end === -1) throw new Error('unterminated YAML front matter')
  return { yamlText: rest.slice(0, end), body: rest.slice(end + 4) }
}

export function parseQueueItem(raw: string): ParsedQueueItem {
  const { yamlText, body } = splitFrontMatter(raw)

  let loaded: unknown
  try {
    loaded = yamlLoad(yamlText)
  } catch (err) {
    throw new Error(`front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('front matter must decode to a map')
  }

  const record = loaded as Record<string, unknown>
  const parsed = FrontMatterSchema.safeParse(record)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
  }
  const fm = parsed.data

  return {
    frontMatter: {
      id: fm.id,
      title: fm.title,
      priority: fm.priority ?? null,
      labels: normalizeLabels(fm.labels),
      blockedBy: (fm.blocked_by ?? []).filter(isValidQueueId),
      branch: guarded(fm.branch, BRANCH_PATTERN),
      jira: guarded(fm.jira, JIRA_PATTERN),
      attempts: fm.attempts ?? 0,
      nextRetryAt: fm.next_retry_at,
      sessionId: guarded(fm.session_id, ID_PATTERN),
      createdAt: fm.created_at,
      updatedAt: fm.updated_at,
    },
    body: body.trim(),
    hadStateField: Object.prototype.hasOwnProperty.call(record, 'state'),
  }
}

export function serializeQueueItem(fm: QueueItemFrontMatter, body: string): string {
  const ordered = {
    id: fm.id,
    title: fm.title,
    priority: fm.priority,
    labels: fm.labels,
    blocked_by: fm.blockedBy,
    branch: fm.branch,
    jira: fm.jira,
    attempts: fm.attempts,
    next_retry_at: fm.nextRetryAt,
    session_id: fm.sessionId,
    created_at: fm.createdAt,
    updated_at: fm.updatedAt,
  }
  const yaml = yamlDump(ordered, { lineWidth: -1, flowLevel: 1, noRefs: true })
  return `---\n${yaml}---\n\n${body.trim()}\n`
}

// --- tracker ----------------------------------------------------------------

interface LoadedItem {
  frontMatter: QueueItemFrontMatter
  body: string
  directory: QueueDirectory
  fileName: string
  filePath: string
}

export interface FileQueueTrackerConfig {
  root: string
  /** Items at or beyond this many attempts stay in failed/ and are never swept. */
  maxAttempts?: number
  maxRetryBackoffMs?: number
  createIfMissing?: boolean
}

export interface CreateItemInput {
  id: string
  title: string
  priority?: number | null
  labels?: string[]
  blockedBy?: string[]
  branch?: string | null
  jira?: string | null
  body?: string
}

export class FileQueueTracker implements TrackerAdapter {
  private readonly root: string
  private readonly maxAttempts: number
  private readonly maxRetryBackoffMs: number
  private tmpCounter = 0

  constructor(config: FileQueueTrackerConfig) {
    this.root = resolve(config.root)
    this.maxAttempts = config.maxAttempts ?? 5
    this.maxRetryBackoffMs = config.maxRetryBackoffMs ?? 300000

    if (config.createIfMissing) {
      for (const dir of DIRECTORY_ORDER) mkdirSync(this.dirPath(dir), { recursive: true })
      return
    }
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
      throw new Error(`queue root does not exist or is not a directory: ${this.root}`)
    }
  }

  // --- TrackerAdapter ---

  async fetchCandidateIssues(): Promise<Issue[]> {
    let items = await this.scan()
    if (await this.sweepDueRetries(items)) items = await this.scan()
    return this.toIssues(items, (i) => CANDIDATE_DIRECTORIES.includes(i.directory))
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return []
    const wanted = new Set(stateNames.map((s) => STATE_TO_DIRECTORY[s]).filter(Boolean))
    if (wanted.size === 0) return []
    return this.toIssues(await this.scan(), (i) => wanted.has(i.directory))
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return []
    const wanted = new Set(issueIds)
    return this.toIssues(await this.scan(), (i) => wanted.has(i.frontMatter.id))
  }

  /**
   * The rename is the claim: moving a file between state directories is atomic
   * within a filesystem, so no lock is needed. Idempotent by design — the file
   * may already have moved (crash, concurrent mover), so we re-scan before
   * failing.
   */
  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    if (!isValidQueueId(issueId)) throw new Error(`invalid queue id: ${JSON.stringify(issueId)}`)
    const target = STATE_TO_DIRECTORY[stateName]
    if (!target) throw new Error(`unknown state: ${stateName}`)

    let item = await this.locate(issueId)
    if (!item) throw new Error(`queue item not found: ${issueId}`)
    if (item.directory === target) return

    let moved = await this.tryMove(item, target)
    if (!moved) {
      // Someone else moved the file between our scan and our rename.
      const relocated = await this.locate(issueId)
      if (!relocated) throw new Error(`queue item not found: ${issueId}`)
      if (relocated.directory === target) return
      item = relocated
      moved = await this.tryMove(item, target)
      if (!moved) throw new Error(`could not move queue item ${issueId} to ${target}`)
    }

    // The claim lands first and the bookkeeping second. A crash in between
    // leaves the item in failed/ with stale counters, which retries early —
    // strictly better than risking the file itself.
    if (target === FAILED_DIRECTORY) {
      const attempts = item.frontMatter.attempts + 1
      await this.rewrite(
        { ...item, directory: target, filePath: join(this.dirPath(target), item.fileName) },
        {
          attempts,
          nextRetryAt: new Date(Date.now() + backoffDelay(attempts, this.maxRetryBackoffMs)),
        },
      )
    }
  }

  // --- queue-specific surface ---

  /** SPEC §14.3: whatever is in in-progress/ at startup is the recovery set. */
  async fetchRecoverableIssues(): Promise<Issue[]> {
    return this.toIssues(await this.scan(), (i) => i.directory === RECOVERY_DIRECTORY)
  }

  /** Moves due failed/ items back to todo/. Returns true if anything moved. */
  async sweepDueRetries(preScanned?: LoadedItem[]): Promise<boolean> {
    const items = preScanned ?? (await this.scan())
    const now = Date.now()
    let moved = false

    for (const item of items) {
      if (item.directory !== FAILED_DIRECTORY) continue
      const { attempts, nextRetryAt, id } = item.frontMatter
      if (attempts >= this.maxAttempts) continue
      // A null deadline means a crash landed the item here before its backoff
      // was stamped; treat it as due rather than stranding it.
      if (nextRetryAt !== null && nextRetryAt.getTime() > now) continue

      if (!(await this.tryMove(item, 'todo'))) {
        getLogger().warn({ id }, 'queue_retry_sweep_move_failed')
        continue
      }
      moved = true
      await this.rewrite(
        { ...item, directory: 'todo', filePath: join(this.dirPath('todo'), item.fileName) },
        { nextRetryAt: null },
      )
      getLogger().info({ id, attempts }, 'queue_item_retry_released')
    }
    return moved
  }

  async createItem(input: CreateItemInput): Promise<Issue> {
    if (!isValidQueueId(input.id)) throw new Error(`invalid queue id: ${JSON.stringify(input.id)}`)
    if (await this.locate(input.id)) throw new Error(`queue item already exists: ${input.id}`)

    const now = new Date()
    const frontMatter: QueueItemFrontMatter = {
      id: input.id,
      title: input.title,
      priority: input.priority ?? null,
      labels: normalizeLabels(input.labels),
      blockedBy: (input.blockedBy ?? []).filter(isValidQueueId),
      branch: guarded(input.branch, BRANCH_PATTERN),
      jira: guarded(input.jira, JIRA_PATTERN),
      attempts: 0,
      nextRetryAt: null,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
    }

    const fileName = `${input.id}-${slugify(input.title)}.md`
    const filePath = this.safeJoin('todo', fileName)
    await this.atomicWrite(filePath, serializeQueueItem(frontMatter, input.body ?? ''))

    return this.toIssue({ frontMatter, body: input.body ?? '', directory: 'todo', fileName, filePath }, new Map())
  }

  itemPath(directory: QueueDirectory, fileName: string): string {
    return this.safeJoin(directory, fileName)
  }

  // --- internals ---

  private dirPath(dir: QueueDirectory): string {
    return join(this.root, dir)
  }

  /** Every path used for I/O goes through here (SPEC §9.5 invariant 2). */
  private safeJoin(dir: QueueDirectory, fileName: string): string {
    const full = resolve(join(this.root, dir, basename(fileName)))
    checkContainment(full, this.dirPath(dir))
    checkContainment(full, this.root)
    return full
  }

  private async scan(): Promise<LoadedItem[]> {
    const log = getLogger()
    const items: LoadedItem[] = []
    const seen = new Set<string>()

    for (const directory of DIRECTORY_ORDER) {
      let entries: string[]
      try {
        entries = await readdir(this.dirPath(directory))
      } catch {
        continue // a missing state directory is not fatal; it is just empty
      }

      for (const fileName of entries) {
        if (!fileName.endsWith('.md')) continue

        let filePath: string
        try {
          filePath = this.safeJoin(directory, fileName)
        } catch (err) {
          log.warn({ directory, fileName, error: String(err) }, 'queue_item_path_rejected')
          continue
        }

        let parsed: ParsedQueueItem
        try {
          parsed = parseQueueItem(await readFile(filePath, 'utf-8'))
        } catch (err) {
          // Never throws out of a poll tick, and never deletes the file: a file
          // we cannot understand is one a human needs to look at.
          log.warn({ filePath, error: err instanceof Error ? err.message : String(err) }, 'queue_item_malformed')
          continue
        }

        if (parsed.hadStateField) {
          log.warn({ id: parsed.frontMatter.id, filePath, directory }, 'queue_item_state_field_ignored')
        }
        if (seen.has(parsed.frontMatter.id)) {
          log.warn({ id: parsed.frontMatter.id, filePath }, 'queue_item_duplicate_id_skipped')
          continue
        }

        seen.add(parsed.frontMatter.id)
        items.push({ frontMatter: parsed.frontMatter, body: parsed.body, directory, fileName, filePath })
      }
    }
    return items
  }

  private async locate(id: string): Promise<LoadedItem | null> {
    return (await this.scan()).find((i) => i.frontMatter.id === id) ?? null
  }

  private async tryMove(item: LoadedItem, target: QueueDirectory): Promise<boolean> {
    const from = this.safeJoin(item.directory, item.fileName)
    const to = this.safeJoin(target, item.fileName)
    try {
      await rename(from, to)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return false
      throw err
    }
  }

  /** Content edits are write-temp-then-rename, in the target's own directory. */
  private async rewrite(item: LoadedItem, patch: Partial<QueueItemFrontMatter>): Promise<void> {
    const frontMatter: QueueItemFrontMatter = { ...item.frontMatter, ...patch, updatedAt: new Date() }
    const target = this.safeJoin(item.directory, item.fileName)
    await this.atomicWrite(target, serializeQueueItem(frontMatter, item.body))
  }

  private async atomicWrite(targetPath: string, contents: string): Promise<void> {
    // The temp file must be a sibling of the target so the rename stays within
    // one filesystem and is therefore atomic.
    const tmpPath = `${targetPath}.${process.pid}.${this.tmpCounter++}.tmp`
    const handle = await open(tmpPath, 'wx')
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(tmpPath, targetPath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
    await syncDirectory(targetPath)
  }

  private toIssues(items: LoadedItem[], predicate: (item: LoadedItem) => boolean): Issue[] {
    const states = new Map(items.map((i) => [i.frontMatter.id, QUEUE_DIRECTORIES[i.directory] as string]))
    return items.filter(predicate).map((i) => this.toIssue(i, states))
  }

  private toIssue(item: LoadedItem, states: Map<string, string>): Issue {
    const fm = item.frontMatter
    const blockedBy: BlockerRef[] = fm.blockedBy.map((id) => ({
      id,
      identifier: id,
      state: states.get(id) ?? null,
    }))

    return {
      id: fm.id,
      identifier: fm.id,
      title: fm.title,
      state: QUEUE_DIRECTORIES[item.directory],
      description: item.body || null,
      priority: fm.priority,
      branchName: fm.branch,
      url: null,
      labels: fm.labels,
      blockedBy,
      createdAt: fm.createdAt,
      updatedAt: fm.updatedAt,
    }
  }
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug || 'item'
}

/** Best effort: makes the rename itself durable, and is a no-op where unsupported. */
async function syncDirectory(filePath: string): Promise<void> {
  try {
    const handle = await open(join(filePath, '..'), 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* not supported on this platform */
  }
}
