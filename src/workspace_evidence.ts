/**
 * What an agent actually left behind in its workspace, read from the filesystem
 * rather than taken on the agent's word.
 *
 * The implementation pipeline has the same blind spot the review pipeline had: an
 * agent that emits the completion marker is believed. The issue moves to In
 * Review, the log says `agent_reported_complete`, and if no branch was ever
 * pushed there is nothing anywhere that says so — the run is indistinguishable
 * from one that worked.
 *
 * This module answers the question that actually splits the diagnosis: did the
 * agent clone, did it commit, did it push? All of it from plain file reads, with
 * no git binary — the orchestrator image deliberately carries no git, and this
 * is a diagnostic, not a workflow step.
 *
 * Two deliberate limits:
 *
 *   - It NEVER reads the contents of `.git/config`. A remote URL can carry an
 *     embedded credential, and this output goes to a log. Only the presence of
 *     a remote section is reported.
 *   - The verdict is ADVISORY. Refs can live loose or packed, a workflow might
 *     legitimately not involve a push at all, and being wrong in a log line is
 *     worse than being vague. The raw facts are always reported alongside it, so
 *     a reader can disagree with the verdict and still be informed.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type WorkspaceVerdict =
  /** No workspace directory at all — nothing was ever created for this run. */
  | 'no_workspace'
  /** The directory exists but holds no git repository: the agent never cloned. */
  | 'not_cloned'
  /** A clone, but no branch beyond what came with it: no work was committed. */
  | 'cloned_no_local_branch'
  /** Local commits on a branch with no matching remote ref: committed, never pushed. */
  | 'committed_not_pushed'
  /** A remote ref matching the local branch exists: the work reached the remote. */
  | 'pushed'
  /** The layout was not something this reader understands. Report the facts, claim nothing. */
  | 'unknown'

export interface WorkspaceEvidence {
  verdict: WorkspaceVerdict
  /** Top-level entry names, capped. Names only — never contents. */
  entries: string[]
  isGitRepo: boolean
  /** The checked-out branch, from `.git/HEAD`. Null on a detached head or an unreadable file. */
  branch: string | null
  localBranches: string[]
  remoteBranches: string[]
  /** Whether `.git/config` declares any remote. Its URL is deliberately never read. */
  hasRemote: boolean
  fileCount: number
}

const MAX_LISTED = 40

/** Branch names under a refs directory, walking subdirectories so `feature/x` is found. */
async function refsUnder(dir: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...(await refsUnder(resolve(join(dir, entry.name)), name)))
    } else {
      found.push(name)
    }
  }
  return found
}

/**
 * Branches recorded in `.git/packed-refs`. A fresh clone packs the refs it
 * received, so reading only loose refs would report a cloned repository as
 * having no branches at all.
 */
async function packedRefs(gitDir: string): Promise<{ heads: string[]; remotes: string[] }> {
  const heads: string[] = []
  const remotes: string[] = []
  let body: string
  try {
    body = await readFile(resolve(join(gitDir, 'packed-refs')), 'utf8')
  } catch {
    return { heads, remotes }
  }
  for (const line of body.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') continue
    const ref = line.slice(line.indexOf(' ') + 1).trim()
    if (ref.startsWith('refs/heads/')) heads.push(ref.slice('refs/heads/'.length))
    else if (ref.startsWith('refs/remotes/')) {
      const withoutPrefix = ref.slice('refs/remotes/'.length)
      // Drop the remote name (`origin/feature/x` -> `feature/x`) so these compare
      // against local branch names.
      const slash = withoutPrefix.indexOf('/')
      if (slash > 0) remotes.push(withoutPrefix.slice(slash + 1))
    }
  }
  return { heads, remotes }
}

export async function describeWorkspaceEvidence(wsPath: string | null): Promise<WorkspaceEvidence> {
  const empty: WorkspaceEvidence = {
    verdict: 'no_workspace',
    entries: [], isGitRepo: false, branch: null,
    localBranches: [], remoteBranches: [], hasRemote: false, fileCount: 0,
  }
  if (!wsPath) return empty

  let entries
  try {
    entries = await readdir(wsPath, { withFileTypes: true })
  } catch {
    return empty
  }

  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
  const gitDir = resolve(join(wsPath, '.git'))
  let isGitRepo = false
  try {
    isGitRepo = (await stat(gitDir)).isDirectory()
  } catch {
    isGitRepo = false
  }

  const base: WorkspaceEvidence = {
    ...empty,
    verdict: isGitRepo ? 'unknown' : 'not_cloned',
    entries: names.slice(0, MAX_LISTED),
    isGitRepo,
    fileCount: names.length,
  }
  if (!isGitRepo) return base

  // HEAD: `ref: refs/heads/<branch>` when on a branch, a bare sha when detached.
  let branch: string | null = null
  try {
    const head = (await readFile(resolve(join(gitDir, 'HEAD')), 'utf8')).trim()
    if (head.startsWith('ref: refs/heads/')) branch = head.slice('ref: refs/heads/'.length)
  } catch { /* unreadable HEAD is itself worth reporting as null */ }

  const packed = await packedRefs(gitDir)
  const localBranches = [...new Set([
    ...(await refsUnder(resolve(join(gitDir, 'refs', 'heads')))),
    ...packed.heads,
  ])].sort()
  const remoteBranches = [...new Set([
    ...(await refsUnder(resolve(join(gitDir, 'refs', 'remotes')))).map((r) => {
      const slash = r.indexOf('/')
      return slash > 0 ? r.slice(slash + 1) : r
    }),
    ...packed.remotes,
  ])].sort()

  let hasRemote = false
  try {
    // Presence only. The URL on the next line can contain a token.
    hasRemote = (await readFile(resolve(join(gitDir, 'config')), 'utf8')).includes('[remote ')
  } catch { /* absent config reads as no remote */ }

  return {
    ...base,
    verdict: verdictFor(branch, localBranches, remoteBranches),
    branch,
    localBranches,
    remoteBranches,
    hasRemote,
  }
}

/**
 * The narrowest claim the refs support.
 *
 * "Pushed" means a remote ref exists for the branch that is checked out — which
 * is what an agent that opened a merge request would have left. It does not
 * prove the merge request itself exists; that is an API call this has no way to
 * see, and the distinction is stated in the log rather than glossed.
 */
function verdictFor(branch: string | null, local: string[], remote: string[]): WorkspaceVerdict {
  if (branch === null) return 'unknown'
  if (remote.includes(branch)) return 'pushed'
  // A branch that exists locally and has no remote ref is work that never left,
  // whether or not the clone brought other refs with it.
  if (local.includes(branch)) return 'committed_not_pushed'
  return local.length === 0 ? 'cloned_no_local_branch' : 'unknown'
}

/** One line an operator can act on, for each verdict. */
export function explainVerdict(evidence: WorkspaceEvidence): string {
  switch (evidence.verdict) {
    case 'no_workspace':
      return 'no workspace directory was found for this run'
    case 'not_cloned':
      return 'the workspace has no git repository — the agent never cloned'
    case 'cloned_no_local_branch':
      return 'the repository was cloned but no branch was created'
    case 'committed_not_pushed':
      return `work exists on branch "${evidence.branch}" but no matching remote ref — nothing was pushed`
    case 'pushed':
      return `branch "${evidence.branch}" reached the remote (whether a merge request was opened is not visible from here)`
    case 'unknown':
      return 'the workspace layout could not be interpreted; the recorded facts are above'
  }
}
