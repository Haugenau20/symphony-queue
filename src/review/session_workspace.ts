/**
 * Isolated filesystem workspaces for parallel review-agent sessions.
 *
 * A review first prepares one trusted, immutable base workspace. Every
 * reviewer/chunk pair and the critic then receives a byte-for-byte copy in a
 * newly-created sibling directory. Files are copied into new inodes (never
 * hard-linked), so an agent may write or edit inside its own workspace without
 * changing the base or another session's view of the merge request.
 *
 * The base is expected not to change while copies are being made. Symlinks and
 * non-file/non-directory entries are rejected instead of followed or copied:
 * review material is a plain file tree, and links would allow one session to
 * reach the base, another session, or a path outside the configured root.
 */

import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { checkContainment } from '../path_safety.js'
import type { Workspace } from '../models.js'

/** Must stay aligned with config.ts's reviewer ID validation. */
export const REVIEWER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

const COPY_BUFFER_BYTES = 64 * 1024

export interface ReviewSessionWorkspaceFactoryConfig {
  /**
   * Review-specific root owned by the caller. The base and every session are
   * direct children of this directory, so no session can be copied into a
   * later session by accident.
   */
  root: string
  /**
   * Prepared material directory. It must be a direct child of `root`, must not
   * be a symlink, and must remain immutable until all sessions are created.
   */
  baseWorkspacePath: string
}

export interface CreateReviewerWorkspaceOptions {
  reviewerId: string
  /** Zero-based material chunk index. */
  chunkIndex: number
  signal?: AbortSignal
}

export interface CreateCriticWorkspaceOptions {
  signal?: AbortSignal
}

/**
 * A caller-owned session handle. Cleanup is deliberately explicit: callers
 * can preserve a failed workspace by simply not calling it.
 */
export interface ReviewSessionWorkspace extends Workspace {
  kind: 'reviewer' | 'critic'
  reviewerId: string | null
  chunkIndex: number | null
  /** Idempotently removes only this factory-created session directory. */
  cleanup(): Promise<void>
}

export function assertValidReviewerId(reviewerId: string): void {
  if (!REVIEWER_ID_PATTERN.test(reviewerId)) {
    throw new Error(
      `Invalid reviewer id ${JSON.stringify(reviewerId)}; expected ${REVIEWER_ID_PATTERN.source}`,
    )
  }
}

function assertValidChunkIndex(chunkIndex: number): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`Invalid chunk index ${String(chunkIndex)}; expected a non-negative safe integer`)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/**
 * Copies a regular file without following a last-component symlink. Using
 * ordinary `copyFile` after an `lstat` would leave a check/use gap in which a
 * replaced source path could be followed. The immutable-base contract means
 * callers must not race this walk, but O_NOFOLLOW is retained as defense in
 * depth and the opened handle is checked before any bytes are copied.
 */
async function copyRegularFile(source: string, destination: string, mode: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)

  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let destinationHandle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const openedStat = await sourceHandle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Review workspace source entry is not a regular file: ${source}`)
    }

    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      // A base may be made owner-read-only to enforce its immutable contract.
      // Session copies still need to be writable by the isolated agent.
      (mode & 0o777) | 0o600,
    )

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    while (true) {
      throwIfAborted(signal)
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break

      let written = 0
      while (written < bytesRead) {
        throwIfAborted(signal)
        const result = await destinationHandle.write(buffer, written, bytesRead - written, null)
        written += result.bytesWritten
      }
    }
  } finally {
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle.close().catch(() => undefined)
  }
}

async function copyDirectoryContents(args: {
  source: string
  destination: string
  baseRealPath: string
  sessionRoot: string
  signal?: AbortSignal
}): Promise<void> {
  const { source, destination, baseRealPath, sessionRoot, signal } = args
  throwIfAborted(signal)

  const entries = await readdir(source, { withFileTypes: true })
  // Filesystem enumeration order is not a contract. Stable order makes failed
  // copies and diagnostics reproducible and keeps tests independent of FS type.
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    throwIfAborted(signal)
    const sourcePath = resolve(join(source, entry.name))
    const destinationPath = resolve(join(destination, entry.name))
    checkContainment(sourcePath, baseRealPath)
    checkContainment(destinationPath, sessionRoot)

    // Do not trust Dirent alone. lstat observes the path without following it,
    // which is the property that matters for a possibly unsafe link.
    const sourceStat = await lstat(sourcePath)
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in review workspace material: ${sourcePath}`)
    }

    if (sourceStat.isDirectory()) {
      const sourceRealPath = await realpath(sourcePath)
      checkContainment(sourceRealPath, baseRealPath)
      if (sourceRealPath !== sourcePath) {
        throw new Error(`Review workspace directory resolved through a link: ${sourcePath}`)
      }
      await mkdir(destinationPath, { mode: (sourceStat.mode & 0o777) | 0o700 })
      await copyDirectoryContents({
        source: sourcePath,
        destination: destinationPath,
        baseRealPath,
        sessionRoot,
        signal,
      })
      continue
    }

    if (sourceStat.isFile()) {
      await copyRegularFile(sourcePath, destinationPath, sourceStat.mode, signal)
      continue
    }

    // Sockets, devices, and FIFOs have no place in static review material and
    // can block a copier or expose resources outside the synthetic workspace.
    throw new Error(`Special files are not allowed in review workspace material: ${sourcePath}`)
  }
}

export class ReviewSessionWorkspaceFactory {
  private readonly root: string
  private readonly baseWorkspacePath: string
  private readonly ownedPaths = new Set<string>()

  constructor(config: ReviewSessionWorkspaceFactoryConfig) {
    this.root = resolve(config.root)
    this.baseWorkspacePath = resolve(config.baseWorkspacePath)

    // Keeping the base and destinations as siblings is a structural safety
    // property: putting destinations below the base would make later copies
    // recursively include earlier sessions and their agent-authored output.
    if (dirname(this.baseWorkspacePath) !== this.root) {
      throw new Error('The review base workspace must be a direct child of the configured workspace root')
    }
    checkContainment(this.baseWorkspacePath, this.root)
  }

  async createReviewerWorkspace(options: CreateReviewerWorkspaceOptions): Promise<ReviewSessionWorkspace> {
    assertValidReviewerId(options.reviewerId)
    assertValidChunkIndex(options.chunkIndex)
    return this.createWorkspace({
      kind: 'reviewer',
      reviewerId: options.reviewerId,
      chunkIndex: options.chunkIndex,
      prefix: `reviewer-${options.reviewerId}-chunk-${options.chunkIndex}-`,
      signal: options.signal,
    })
  }

  async createCriticWorkspace(options: CreateCriticWorkspaceOptions = {}): Promise<ReviewSessionWorkspace> {
    return this.createWorkspace({
      kind: 'critic',
      reviewerId: null,
      chunkIndex: null,
      prefix: 'critic-',
      signal: options.signal,
    })
  }

  private async createWorkspace(args: {
    kind: 'reviewer' | 'critic'
    reviewerId: string | null
    chunkIndex: number | null
    prefix: string
    signal?: AbortSignal
  }): Promise<ReviewSessionWorkspace> {
    const { rootRealPath, baseRealPath } = await this.validateRoots()
    throwIfAborted(args.signal)

    let destination: string | null = null
    try {
      // mkdtemp both guarantees uniqueness under parallel fan-out and creates
      // the directory before any untrusted name can race us to that path.
      destination = await mkdtemp(join(this.root, args.prefix))
      const destinationResolved = resolve(destination)
      checkContainment(destinationResolved, rootRealPath)
      if (dirname(destinationResolved) !== rootRealPath) {
        throw new Error('Review session workspace was not created as a sibling of the base workspace')
      }

      const destinationStat = await lstat(destinationResolved)
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error('Review session destination is not a plain directory')
      }
      const destinationRealPath = await realpath(destinationResolved)
      if (destinationRealPath !== destinationResolved) {
        throw new Error('Review session destination resolved through a symbolic link')
      }

      await copyDirectoryContents({
        source: baseRealPath,
        destination: destinationRealPath,
        baseRealPath,
        sessionRoot: destinationRealPath,
        signal: args.signal,
      })

      this.ownedPaths.add(destinationRealPath)
      let cleaned = false
      const cleanup = async () => {
        if (cleaned) return
        checkContainment(destinationRealPath, rootRealPath)
        if (!this.ownedPaths.has(destinationRealPath)) {
          throw new Error('Refusing to clean a review workspace not owned by this factory')
        }
        await rm(destinationRealPath, { recursive: true, force: true })
        this.ownedPaths.delete(destinationRealPath)
        cleaned = true
      }

      return {
        path: destinationRealPath,
        workspaceKey: basename(destinationRealPath),
        createdNow: true,
        kind: args.kind,
        reviewerId: args.reviewerId,
        chunkIndex: args.chunkIndex,
        cleanup,
      }
    } catch (error) {
      // A partially-copied tree is never a usable session. This internal
      // cleanup is distinct from successful-session cleanup, which remains a
      // caller decision so failed agent workspaces can be kept for inspection.
      if (destination !== null) {
        const partial = resolve(destination)
        checkContainment(partial, rootRealPath)
        await rm(partial, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  private async validateRoots(): Promise<{ rootRealPath: string; baseRealPath: string }> {
    const rootStat = await lstat(this.root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Review workspace root must be a plain directory, not a symbolic link')
    }
    const rootRealPath = await realpath(this.root)
    if (rootRealPath !== this.root) {
      throw new Error('Review workspace root resolved through a symbolic link')
    }

    const baseStat = await lstat(this.baseWorkspacePath)
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw new Error('Review base workspace must be a plain directory, not a symbolic link')
    }
    const baseRealPath = await realpath(this.baseWorkspacePath)
    checkContainment(baseRealPath, rootRealPath)
    if (baseRealPath !== this.baseWorkspacePath || dirname(baseRealPath) !== rootRealPath) {
      throw new Error('Review base workspace must be a plain direct child of the workspace root')
    }

    return { rootRealPath, baseRealPath }
  }
}
