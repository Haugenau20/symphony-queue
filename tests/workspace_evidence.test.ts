import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describeWorkspaceEvidence, explainVerdict } from '../src/workspace_evidence.js'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ws-evidence-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Builds the parts of a .git directory this reader looks at. */
function gitRepo(opts: {
  head?: string
  localBranches?: string[]
  remoteBranches?: string[]
  packedRefs?: string[]
  config?: string
} = {}): string {
  const ws = join(root, 'issue-7')
  const git = join(ws, '.git')
  mkdirSync(git, { recursive: true })
  writeFileSync(join(git, 'HEAD'), opts.head ?? 'ref: refs/heads/main\n')
  for (const b of opts.localBranches ?? []) {
    const path = join(git, 'refs', 'heads', b)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'a'.repeat(40) + '\n')
  }
  for (const b of opts.remoteBranches ?? []) {
    const path = join(git, 'refs', 'remotes', 'origin', b)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'a'.repeat(40) + '\n')
  }
  if (opts.packedRefs) {
    writeFileSync(join(git, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${opts.packedRefs.join('\n')}\n`)
  }
  if (opts.config !== undefined) writeFileSync(join(git, 'config'), opts.config)
  return ws
}

describe('describeWorkspaceEvidence', () => {
  it('reports no_workspace for a null path', async () => {
    expect((await describeWorkspaceEvidence(null)).verdict).toBe('no_workspace')
  })

  it('reports no_workspace for a directory that does not exist', async () => {
    expect((await describeWorkspaceEvidence(join(root, 'nope'))).verdict).toBe('no_workspace')
  })

  /** The user-visible failure: the agent said it was done and never cloned. */
  it('reports not_cloned for an empty workspace', async () => {
    const ws = join(root, 'issue-7')
    mkdirSync(ws, { recursive: true })

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.verdict).toBe('not_cloned')
    expect(evidence.isGitRepo).toBe(false)
    expect(explainVerdict(evidence)).toContain('never cloned')
  })

  it('reports not_cloned when files were written but no repository exists', async () => {
    const ws = join(root, 'issue-7')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'notes.md'), 'I thought about it')

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.verdict).toBe('not_cloned')
    expect(evidence.entries).toContain('notes.md')
  })

  it('reports committed_not_pushed when the checked-out branch has no remote ref', async () => {
    const ws = gitRepo({
      head: 'ref: refs/heads/symphony/issue-7\n',
      localBranches: ['main'],
      remoteBranches: ['main'],
      packedRefs: [],
    })
    // the work branch exists locally only
    mkdirSync(join(ws, '.git', 'refs', 'heads', 'symphony'), { recursive: true })
    writeFileSync(join(ws, '.git', 'refs', 'heads', 'symphony', 'issue-7'), 'b'.repeat(40))

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.verdict).toBe('committed_not_pushed')
    expect(evidence.branch).toBe('symphony/issue-7')
    expect(explainVerdict(evidence)).toContain('nothing was pushed')
  })

  it('reports pushed when a remote ref matches the checked-out branch', async () => {
    const ws = gitRepo({
      head: 'ref: refs/heads/feature/x\n',
      localBranches: ['feature/x'],
      remoteBranches: ['feature/x'],
    })

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.verdict).toBe('pushed')
    // Deliberately does not claim a merge request exists — it cannot see one.
    expect(explainVerdict(evidence)).toContain('not visible from here')
  })

  /**
   * A fresh clone PACKS the refs it received, so a reader that only walked loose
   * refs would report a perfectly normal clone as having no branches — and then
   * annotate the issue about it.
   */
  it('finds branches in packed-refs, not just loose refs', async () => {
    const ws = gitRepo({
      head: 'ref: refs/heads/main\n',
      packedRefs: [
        `${'a'.repeat(40)} refs/heads/main`,
        `${'a'.repeat(40)} refs/remotes/origin/main`,
      ],
    })

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.localBranches).toContain('main')
    expect(evidence.remoteBranches).toContain('main')
    expect(evidence.verdict).toBe('pushed')
  })

  it('reports cloned_no_local_branch when HEAD names a branch that has no ref yet', async () => {
    const ws = gitRepo({ head: 'ref: refs/heads/main\n' })

    expect((await describeWorkspaceEvidence(ws)).verdict).toBe('cloned_no_local_branch')
  })

  it('reports unknown for a detached head rather than guessing', async () => {
    const ws = gitRepo({ head: `${'c'.repeat(40)}\n` })

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.verdict).toBe('unknown')
    expect(evidence.branch).toBeNull()
  })

  it('notes that a remote is configured without reading its URL', async () => {
    const ws = gitRepo({
      head: 'ref: refs/heads/main\n',
      localBranches: ['main'],
      config: '[remote "origin"]\n\turl = https://oauth2:glpat-SECRET@gitlab.example/a/b.git\n',
    })

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.hasRemote).toBe(true)
    // The whole point: a remote URL can carry a credential, and this goes to a log.
    expect(JSON.stringify(evidence)).not.toContain('glpat-SECRET')
    expect(JSON.stringify(evidence)).not.toContain('gitlab.example')
  })

  it('caps the entry listing so a huge workspace cannot flood a log line', async () => {
    const ws = join(root, 'issue-7')
    mkdirSync(ws, { recursive: true })
    for (let i = 0; i < 120; i++) writeFileSync(join(ws, `f${i}.txt`), 'x')

    const evidence = await describeWorkspaceEvidence(ws)

    expect(evidence.fileCount).toBe(120)
    expect(evidence.entries.length).toBeLessThanOrEqual(40)
  })
})
