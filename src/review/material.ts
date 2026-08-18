/**
 * The review material planner: exclusion and chunking of a merge request's
 * diff, as one pure function.
 *
 * Pure by design — no fs, no network, no clock, no logger. The planner works
 * only on the diff metadata it is given ({@link MergeRequestDiffFile}); if a
 * caller needs a file's content to plan, the plan is wrong. Determinism
 * follows from purity: the same input list, in the same order, with the same
 * options, produces byte-identical chunks every time. That matters because a
 * chunk's `index` is published in the review note — a plan that renumbers
 * itself between attempts (a retry, a re-run after a transient failure) would
 * make that note wrong the second time round.
 *
 * ORDER OF OPERATIONS (load-bearing, do not reorder):
 *
 *   1. exclude_paths      — matched against BOTH oldPath and newPath. Reason
 *                            'exclude_path'.
 *   2. generated files    — GitLab's own `generatedFile` flag, only when
 *                            `options.excludeGenerated`. Reason 'generated'.
 *   3. binary files       — via diff.ts's `isBinaryDiffMarker`. Reason 'binary'.
 *   4. collapsed files    — GitLab sent an empty diff body for a file it
 *                            reports as changed (`file.collapsed`, computed by
 *                            gitlab_mr.ts via diff.ts's `isCollapsedDiff`).
 *                            Reason 'collapsed'.
 *   5. byte accounting and chunking over whatever survives 1-4.
 *
 * Exclusion happens before accounting for two independent reasons, and both
 * have to hold:
 *   - A huge excluded file must never count against the chunk budget — an
 *     operator's exclude_paths rule would otherwise still cost chunks.
 *   - A file GitLab could not or would not render (collapsed, binary) must
 *     never be silently counted as "reviewed" — that is exactly the honesty
 *     problem the whole design exists to avoid.
 *
 * Each file is checked against 1-4 in order and dropped at the FIRST rule it
 * matches, so a file matching more than one rule (e.g. both generated and
 * collapsed) reports exactly one reason: the earliest one in the list above.
 */

import { isBinaryDiffMarker } from './diff.js'
import type {
  ExcludedFile,
  ExclusionReason,
  MaterialPlannerOptions,
  MergeRequestDiffFile,
  ReviewChunk,
  ReviewPlanResult,
} from './types.js'

// --- glob matching for exclude_paths -----------------------------------------
//
// MOVED here from worker.ts (and re-exported there for existing imports): this
// is pure glob code that belongs beside the rest of the pure planning logic,
// not in a file whose job is I/O.

/** Converts a `*`/`**` glob into an anchored RegExp. `**` matches across `/`; a lone `*` does not. */
export function globToRegExp(pattern: string): RegExp {
  let body = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*'
        i += 2
        continue
      }
      body += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      body += '[^/]'
      i += 1
      continue
    }
    body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${body}$`)
}

export function isExcludedPath(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return patterns.some((p) => globToRegExp(p).test(path))
}

// --- helpers ------------------------------------------------------------------

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function pathOf(file: MergeRequestDiffFile): string {
  return file.newPath || file.oldPath
}

/** Directory portion of a repo-relative path, `''` for a file at the root. */
function directoryOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/**
 * The exclusion pass. Returns the files that survive, in their original
 * order, and the excluded files with the earliest-matching reason — checked
 * in the fixed order exclude_path -> generated -> binary -> collapsed, so a
 * file matching several rules is attributed to the first one, deterministically.
 */
function partitionExclusions(
  files: MergeRequestDiffFile[],
  options: MaterialPlannerOptions,
): { included: MergeRequestDiffFile[]; excluded: ExcludedFile[] } {
  const included: MergeRequestDiffFile[] = []
  const excluded: ExcludedFile[] = []

  for (const file of files) {
    const reason = classifyExclusion(file, options)
    if (reason === null) {
      included.push(file)
    } else {
      excluded.push({ path: pathOf(file), reason })
    }
  }

  return { included, excluded }
}

function classifyExclusion(
  file: MergeRequestDiffFile,
  options: MaterialPlannerOptions,
): ExclusionReason | null {
  // 1. exclude_paths — against BOTH oldPath and newPath, today's rule, preserved.
  if (isExcludedPath(file.newPath, options.excludePaths) || isExcludedPath(file.oldPath, options.excludePaths)) {
    return 'exclude_path'
  }

  // 2. generated files, only when the option is on.
  if (options.excludeGenerated && file.generatedFile) {
    return 'generated'
  }

  // 3. binary files — the diff body carries git's own marker.
  if (isBinaryDiffMarker(file.diff)) {
    return 'binary'
  }

  // 4. collapsed files — GitLab sent an empty diff body for a file it reports as changed.
  if (file.collapsed) {
    return 'collapsed'
  }

  return null
}

/**
 * Packs `files` into chunks in input order, never splitting one file's diff
 * across two chunks. A file whose own diff bytes already exceed
 * `maxChunkBytes` gets its own oversized chunk rather than being refused or
 * split — dropping it would silently discard the largest change in the merge
 * request, which is the one most worth reading.
 *
 * Directory grouping: before packing, files are reordered into runs of
 * contiguous same-directory files, using each directory's FIRST appearance in
 * the input to decide where its run sits. Concretely: walk the input in
 * order; the first time a directory is seen, emit every file from that
 * directory (in their original relative order) as one contiguous run, then
 * continue scanning for the next not-yet-emitted directory. This is a stable
 * grouping (files never move earlier than their directory's first
 * appearance) that keeps same-directory files adjacent so the greedy packer
 * below is more likely to land them in the same chunk. It reduces the risk of
 * a cross-file issue falling between chunk boundaries — it does not remove
 * it: a directory whose total size crosses a chunk boundary still splits
 * across chunks, and packing is still greedy by byte budget, not by
 * directory. No file is reordered relative to others in its own directory,
 * and the set of files is unchanged — only their chunk-packing order.
 */
function groupByDirectory(files: MergeRequestDiffFile[]): MergeRequestDiffFile[] {
  const byDir = new Map<string, MergeRequestDiffFile[]>()
  for (const f of files) {
    const dir = directoryOf(pathOf(f))
    const bucket = byDir.get(dir)
    if (bucket) bucket.push(f)
    else byDir.set(dir, [f])
  }

  const emitted = new Set<string>()
  const ordered: MergeRequestDiffFile[] = []
  for (const f of files) {
    const dir = directoryOf(pathOf(f))
    if (emitted.has(dir)) continue
    emitted.add(dir)
    const bucket = byDir.get(dir)
    if (bucket) ordered.push(...bucket)
  }
  return ordered
}

function packChunks(files: MergeRequestDiffFile[], maxChunkBytes: number): ReviewChunk[] {
  const chunks: ReviewChunk[] = []
  let currentFiles: MergeRequestDiffFile[] = []
  let currentBytes = 0

  const flush = () => {
    if (currentFiles.length === 0) return
    chunks.push({ index: chunks.length, files: currentFiles, diffBytes: currentBytes })
    currentFiles = []
    currentBytes = 0
  }

  for (const file of files) {
    const fileBytes = byteLength(file.diff)

    // A single file over budget on its own gets its own oversized chunk —
    // never split, never dropped. Flush whatever is pending first so it does
    // not get folded into the oversized chunk.
    if (fileBytes > maxChunkBytes) {
      flush()
      chunks.push({ index: chunks.length, files: [file], diffBytes: fileBytes })
      continue
    }

    if (currentFiles.length > 0 && currentBytes + fileBytes > maxChunkBytes) {
      flush()
    }

    currentFiles.push(file)
    currentBytes += fileBytes
  }

  flush()
  return chunks
}

export function planReviewMaterial(
  files: MergeRequestDiffFile[],
  options: MaterialPlannerOptions,
): ReviewPlanResult {
  const { included, excluded } = partitionExclusions(files, options)

  const collapsedExcludedCount = excluded.filter((e) => e.reason === 'collapsed').length

  if (included.length === 0 && collapsedExcludedCount > 0) {
    // The honest "GitLab would not show us this" case — everything that
    // survived exclude_paths/generated/binary was collapsed. Zero INPUT files
    // is a different, non-refusal case handled below (an empty plan).
    return {
      kind: 'refused',
      reason: 'nothing_reviewable',
      filesConsidered: files.length,
      diffBytes: 0,
      chunksRequired: 0,
      maxChunks: options.maxChunks,
    }
  }

  const ordered = groupByDirectory(included)
  const chunks = packChunks(ordered, options.maxChunkBytes)

  if (chunks.length > options.maxChunks) {
    let diffBytes = 0
    for (const f of included) diffBytes += byteLength(f.diff)
    return {
      kind: 'refused',
      reason: 'too_many_chunks',
      // Every file the planner was handed, matching the 'nothing_reviewable'
      // branch above — see ReviewPlanRefusal.filesConsidered. `diffBytes` below
      // is the one that counts only reviewable material.
      filesConsidered: files.length,
      diffBytes,
      chunksRequired: chunks.length,
      maxChunks: options.maxChunks,
    }
  }

  let diffBytes = 0
  for (const chunk of chunks) diffBytes += chunk.diffBytes

  return {
    kind: 'plan',
    chunks,
    excluded,
    diffBytes,
  }
}
