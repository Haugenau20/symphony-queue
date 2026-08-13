/**
 * A directory tree implementing ReviewStore, following file_queue.ts's proven
 * idiom (docs/DESIGN.md §2, §5) even though the file queue itself is on its
 * way out — the idiom is kept for its properties, not for consistency with a
 * component being retired:
 *
 *   <root>/projects/<url-encoded-project>/<mrIid>/<headSha>.json
 *   <root>/claimed/<key-hash>.json
 *   <root>/failed/<key-hash>.json
 *   <root>/cursor.json
 *
 * A record's directory tracks its ReviewJobState:
 *   - discovered, published, superseded, skipped -> projects/.../<headSha>.json
 *     (discovered records start here; terminal records are moved back here so
 *     `ls` over `projects/` shows the whole history of one MR revision, per
 *     the design's tree diagram in §8)
 *   - claimed, running, publishing            -> claimed/<hash(key)>.json
 *   - failed                                   -> failed/<hash(key)>.json
 *
 * `claim()` is the one place a record moves via `rename(2)` alone — no
 * content changes, so the move itself is the atomic claim signal, exactly as
 * DESIGN.md §2 describes for the file queue. Every other state transition
 * both moves *and* rewrites content, which cannot be done in one atomic
 * filesystem operation: the new content is written atomically at its target
 * location first (temp-in-target-dir, fsync, rename — never the system temp
 * dir, which would reintroduce EXDEV), and only then is the stale copy at the
 * old location removed. A crash in that window leaves a harmless duplicate
 * (the old, stale copy) rather than losing the record; the next read of the
 * correct location already sees the up-to-date content. This mirrors the
 * crash-ordering trade-off DESIGN.md §9 makes for the same reason.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { checkContainment } from '../path_safety.js'
import { getLogger } from '../log.js'
import type { ReviewJob, ReviewJobKey, ReviewJobState, ReviewStore } from './types.js'

const IN_FLIGHT: ReadonlySet<ReviewJobState> = new Set(['claimed', 'running', 'publishing'])

// --- on-disk record schema ---------------------------------------------------
//
// The store's own JSON, written only by this module — not untrusted agent
// output, so this follows file_queue's posture (unknown keys dropped, not
// findings.ts's stricter one) rather than Ruling 1. A record that fails this
// schema is logged and skipped, never auto-deleted or auto-repaired: it is
// evidence a human should look at, the same rule DESIGN.md §5 states for a
// malformed queue file.

const dateRequired = z.preprocess((v) => {
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? 'invalid' : d
  }
  return 'invalid'
}, z.date())

const dateOrNull = z.preprocess((v) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? 'invalid' : d
  }
  return 'invalid'
}, z.date().nullable())

const ReviewJobKeySchema = z.object({
  projectId: z.string().min(1),
  mrIid: z.number().int(),
  headSha: z.string(),
})

const ReviewJobSchema = z.object({
  key: ReviewJobKeySchema,
  baseSha: z.string(),
  startSha: z.string(),
  title: z.string(),
  webUrl: z.string().nullable(),
  state: z.enum([
    'discovered', 'claimed', 'running', 'publishing',
    'published', 'superseded', 'skipped', 'failed',
  ]),
  attempts: z.number().int().min(0),
  nextRetryAt: dateOrNull,
  discoveredAt: dateRequired,
  publishedNoteId: z.string().nullable(),
  skipReason: z.string().nullable(),
})

// --- store --------------------------------------------------------------------

export interface ReviewStoreConfig {
  root: string
  /**
   * Records at or beyond this many attempts stay in failed/ and are never
   * swept by listClaimable. Not on ReviewJob (it has no maxAttempts field);
   * a constructor option instead, per the wave-2 orchestrator addendum's
   * ruling 2 — injectable for tests, configurable later by the controller,
   * deliberately not read from config.ts.
   */
  maxAttempts?: number
  createIfMissing?: boolean
}

interface LocatedRecord {
  path: string
  job: ReviewJob
}

export class DirectoryReviewStore implements ReviewStore {
  private readonly root: string
  private readonly maxAttempts: number
  private readonly instanceId: string
  private tmpCounter = 0

  constructor(config: ReviewStoreConfig) {
    this.root = resolve(config.root)
    this.maxAttempts = config.maxAttempts ?? 3
    // Distinguishes temp files from two DirectoryReviewStore instances that
    // happen to share a process (as two "competing workers" do in tests) —
    // process.pid alone is not enough in that case.
    this.instanceId = createHash('sha256').update(`${process.pid}:${Math.random()}:${Date.now()}`).digest('hex').slice(0, 12)

    if (config.createIfMissing) {
      mkdirSync(this.projectsRoot(), { recursive: true })
      mkdirSync(this.claimedRoot(), { recursive: true })
      mkdirSync(this.failedRoot(), { recursive: true })
      return
    }
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
      throw new Error(`review store root does not exist or is not a directory: ${this.root}`)
    }
  }

  // --- ReviewStore -----------------------------------------------------------

  async get(key: ReviewJobKey): Promise<ReviewJob | null> {
    const found = await this.locate(key)
    return found?.job ?? null
  }

  async put(job: ReviewJob): Promise<void> {
    await this.writeAt(this.locationFor(job), job)
  }

  async update(job: ReviewJob): Promise<void> {
    const target = this.locationFor(job)
    const existing = await this.locate(job.key)
    await this.writeAt(target, job)
    if (existing && existing.path !== target) {
      await unlink(existing.path).catch((err: unknown) => {
        getLogger().warn(
          { path: existing.path, error: err instanceof Error ? err.message : String(err) },
          'review_store_stale_copy_cleanup_failed',
        )
      })
    }
  }

  /**
   * rename(2) is the claim: two processes racing to claim the same key cannot
   * both win, because the loser's rename fails with ENOENT. That is resolved
   * to `false`, never thrown — the caller's normal path, not an error case.
   */
  async claim(key: ReviewJobKey): Promise<boolean> {
    const found = await this.locateClaimable(key)
    if (!found) return false

    const to = this.claimedPath(key)
    await mkdir(dirname(to), { recursive: true })
    try {
      await rename(found.path, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }

    // The rename lands first and is the claim; the content rewrite (marking
    // state: 'claimed') happens second, exactly the ordering DESIGN.md §9
    // uses for the file queue's own claim-then-bookkeeping split. A crash
    // between the two leaves the record physically claimed but still
    // reporting its pre-claim state, which recoverInFlight still returns
    // (anything in claimed/ is live-or-was-live), so nothing is lost.
    const claimedJob: ReviewJob = { ...found.job, state: 'claimed' }
    await this.writeAt(to, claimedJob)
    return true
  }

  async listClaimable(now: Date): Promise<ReviewJob[]> {
    const [discovered, dueFailed] = await Promise.all([this.scanDiscovered(), this.scanDueFailed(now)])
    return [...discovered, ...dueFailed]
  }

  /** claimed/running/publishing at startup — the set that was live when the process died. */
  async recoverInFlight(): Promise<ReviewJob[]> {
    return this.readAllIn(this.claimedRoot())
  }

  async readCursor(): Promise<Date | null> {
    const raw = await this.readFileOrNull(this.cursorPath())
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      getLogger().warn(
        { path: this.cursorPath(), error: err instanceof Error ? err.message : String(err) },
        'review_store_cursor_malformed',
      )
      return null
    }
    const at = (parsed as { at?: unknown }).at
    if (typeof at !== 'string') return null
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return null
    return d
  }

  async writeCursor(at: Date): Promise<void> {
    await this.atomicWrite(this.cursorPath(), JSON.stringify({ at: at.toISOString() }, null, 2))
  }

  // --- location -----------------------------------------------------------------

  /**
   * Every record for one merge request, at any head SHA, in any state.
   *
   * Three locations have to be consulted, and only one of them can be reached
   * by deriving a path: `projects/<project>/<iid>/` is a directory that can be
   * listed, but `claimed/` and `failed/` are keyed by a hash of the FULL job
   * key — head SHA included — which is precisely the component this lookup does
   * not have. So those two are scanned and filtered on the record's own
   * contents.
   *
   * A head SHA present in more than one location resolves the same way
   * {@link locate} does: the more "live" copy wins, claimed over failed over
   * discovered. Reads reuse {@link readRecord}, so a malformed record is logged
   * and skipped rather than thrown or repaired.
   */
  async listForMergeRequest(projectId: string, mrIid: number): Promise<ReviewJob[]> {
    if (!Number.isInteger(mrIid)) throw new Error(`review store: invalid mrIid: ${String(mrIid)}`)

    const matches = (job: ReviewJob): boolean =>
      job.key.projectId === projectId && job.key.mrIid === mrIid

    // Ordered least-live first, so a later assignment overwrites an earlier one
    // and the most authoritative copy of a head SHA is the one that survives.
    const bySha = new Map<string, ReviewJob>()

    for (const job of await this.readAllIn(this.mrDirFor(projectId, mrIid))) {
      if (matches(job)) bySha.set(job.key.headSha, job)
    }
    for (const job of await this.readAllIn(this.failedRoot())) {
      if (matches(job)) bySha.set(job.key.headSha, job)
    }
    for (const job of await this.readAllIn(this.claimedRoot())) {
      if (matches(job)) bySha.set(job.key.headSha, job)
    }

    return Array.from(bySha.values()).sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())
  }

  private locationFor(job: ReviewJob): string {
    if (IN_FLIGHT.has(job.state)) return this.claimedPath(job.key)
    if (job.state === 'failed') return this.failedPath(job.key)
    return this.discoveredPath(job.key)
  }

  private projectsRoot(): string {
    return join(this.root, 'projects')
  }

  private claimedRoot(): string {
    return join(this.root, 'claimed')
  }

  private failedRoot(): string {
    return join(this.root, 'failed')
  }

  private cursorPath(): string {
    const full = resolve(join(this.root, 'cursor.json'))
    checkContainment(full, this.root)
    return full
  }

  private projectDir(projectId: string): string {
    const encoded = encodeURIComponent(projectId)
    const dir = resolve(join(this.projectsRoot(), encoded))
    checkContainment(dir, this.projectsRoot())
    checkContainment(dir, this.root)
    return dir
  }

  private mrDir(key: ReviewJobKey): string {
    return this.mrDirFor(key.projectId, key.mrIid)
  }

  /**
   * Split out from {@link mrDir} because supersession needs this directory
   * without holding a head SHA, and therefore without a full {@link ReviewJobKey}.
   * The containment checks are the point of the function and apply either way:
   * `projectId` reaches the filesystem here and is attacker-influenced.
   */
  private mrDirFor(projectId: string, mrIid: number): string {
    if (!Number.isInteger(mrIid)) throw new Error(`review store: invalid mrIid: ${String(mrIid)}`)
    const project = this.projectDir(projectId)
    const dir = resolve(join(project, String(mrIid)))
    checkContainment(dir, project)
    checkContainment(dir, this.root)
    return dir
  }

  private discoveredPath(key: ReviewJobKey): string {
    const dir = this.mrDir(key)
    const encodedSha = encodeURIComponent(key.headSha)
    const full = resolve(join(dir, `${encodedSha}.json`))
    checkContainment(full, dir)
    checkContainment(full, this.root)
    return full
  }

  /** A hash of the full key, independent of any of its components' shape — never itself a path-traversal vector. */
  private hashKey(key: ReviewJobKey): string {
    return createHash('sha256').update(`${key.projectId}::${key.mrIid}::${key.headSha}`).digest('hex')
  }

  private claimedPath(key: ReviewJobKey): string {
    const full = resolve(join(this.claimedRoot(), `${this.hashKey(key)}.json`))
    checkContainment(full, this.claimedRoot())
    checkContainment(full, this.root)
    return full
  }

  private failedPath(key: ReviewJobKey): string {
    const full = resolve(join(this.failedRoot(), `${this.hashKey(key)}.json`))
    checkContainment(full, this.failedRoot())
    checkContainment(full, this.root)
    return full
  }

  // --- lookup ---------------------------------------------------------------

  /** Every location a record for this key could currently be in, in an order that prefers the more "live" copy. */
  private async locate(key: ReviewJobKey): Promise<LocatedRecord | null> {
    for (const path of [this.claimedPath(key), this.failedPath(key), this.discoveredPath(key)]) {
      const job = await this.readRecord(path)
      if (job) return { path, job }
    }
    return null
  }

  /** Same as locate(), but never looks in claimed/ — a record already claimed has nothing left to win. */
  private async locateClaimable(key: ReviewJobKey): Promise<LocatedRecord | null> {
    for (const path of [this.failedPath(key), this.discoveredPath(key)]) {
      const job = await this.readRecord(path)
      if (job) return { path, job }
    }
    return null
  }

  private async scanDiscovered(): Promise<ReviewJob[]> {
    const out: ReviewJob[] = []
    let projectDirs: string[]
    try {
      projectDirs = await readdir(this.projectsRoot())
    } catch {
      return out
    }
    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsRoot(), projectDir)
      let mrDirs: string[]
      try {
        mrDirs = await readdir(projectPath)
      } catch {
        continue
      }
      for (const mrDir of mrDirs) {
        const mrPath = join(projectPath, mrDir)
        let files: string[]
        try {
          files = await readdir(mrPath)
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const job = await this.readRecord(join(mrPath, file))
          if (job && job.state === 'discovered') out.push(job)
        }
      }
    }
    return out
  }

  private async scanDueFailed(now: Date): Promise<ReviewJob[]> {
    const jobs = await this.readAllIn(this.failedRoot())
    return jobs.filter((job) => {
      if (job.state !== 'failed') return false
      if (job.attempts >= this.maxAttempts) return false
      if (job.nextRetryAt !== null && job.nextRetryAt.getTime() > now.getTime()) return false
      return true
    })
  }

  private async readAllIn(dir: string): Promise<ReviewJob[]> {
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const out: ReviewJob[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const job = await this.readRecord(join(dir, file))
      if (job) out.push(job)
    }
    return out
  }

  // --- record I/O -------------------------------------------------------------

  private async readFileOrNull(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** Reads and validates a record. A malformed file is logged and treated as absent — never thrown, never repaired. */
  private async readRecord(path: string): Promise<ReviewJob | null> {
    const raw = await this.readFileOrNull(path)
    if (raw === null) return null

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch (err) {
      getLogger().warn({ path, error: err instanceof Error ? err.message : String(err) }, 'review_store_record_malformed')
      return null
    }

    const result = ReviewJobSchema.safeParse(parsedJson)
    if (!result.success) {
      getLogger().warn(
        { path, error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') },
        'review_store_record_malformed',
      )
      return null
    }
    return result.data
  }

  private serialize(job: ReviewJob): string {
    const record = {
      key: job.key,
      baseSha: job.baseSha,
      startSha: job.startSha,
      title: job.title,
      webUrl: job.webUrl,
      state: job.state,
      attempts: job.attempts,
      nextRetryAt: job.nextRetryAt ? job.nextRetryAt.toISOString() : null,
      discoveredAt: job.discoveredAt.toISOString(),
      publishedNoteId: job.publishedNoteId,
      skipReason: job.skipReason,
    }
    return JSON.stringify(record, null, 2)
  }

  private async writeAt(path: string, job: ReviewJob): Promise<void> {
    await this.atomicWrite(path, this.serialize(job))
  }

  /** write-temp-in-same-dir, fsync, rename. The temp file is never written to the system temp dir — that reintroduces EXDEV. */
  private async atomicWrite(targetPath: string, contents: string): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true })
    const tmpPath = `${targetPath}.${this.instanceId}.${this.tmpCounter++}.tmp`
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
