import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REVIEWER_ID_PATTERN,
  ReviewSessionWorkspaceFactory,
  assertValidReviewerId,
} from '../../src/review/session_workspace.js'

let scratch: string
let root: string
let base: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'symphony-session-workspace-'))
  root = join(scratch, 'review')
  base = join(root, 'base')
  mkdirSync(join(base, 'diff', 'src'), { recursive: true })
  mkdirSync(join(base, 'files', 'src'), { recursive: true })
  writeFileSync(join(base, 'MR.md'), '# original material\n')
  writeFileSync(join(base, 'diff', 'src', 'feature.ts.diff'), '@@ -1 +1 @@\n-old\n+new\n')
  writeFileSync(join(base, 'files', 'src', 'feature.ts'), 'export const value = "base"\n')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function factory(): ReviewSessionWorkspaceFactory {
  return new ReviewSessionWorkspaceFactory({ root, baseWorkspacePath: base })
}

describe('reviewer IDs', () => {
  it('uses exactly the normalized config contract', () => {
    expect(REVIEWER_ID_PATTERN.source).toBe('^[a-z][a-z0-9_-]{0,63}$')
    expect(() => assertValidReviewerId('general')).not.toThrow()
    expect(() => assertValidReviewerId('security_2')).not.toThrow()
    expect(() => assertValidReviewerId('reliability-check')).not.toThrow()
  })

  it.each([
    '',
    'General',
    '1general',
    '../general',
    'general.review',
    'general review',
    `a${'b'.repeat(64)}`,
  ])('rejects unsafe reviewer id %j before creating a destination', async (reviewerId) => {
    const before = readdirSync(root)
    await expect(factory().createReviewerWorkspace({ reviewerId, chunkIndex: 0 })).rejects.toThrow(
      /Invalid reviewer id/,
    )
    expect(readdirSync(root)).toEqual(before)
  })

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid chunk index %s before creating a destination',
    async (chunkIndex) => {
      const before = readdirSync(root)
      await expect(factory().createReviewerWorkspace({ reviewerId: 'general', chunkIndex })).rejects.toThrow(
        /Invalid chunk index/,
      )
      expect(readdirSync(root)).toEqual(before)
    },
  )
})

describe('isolated copies', () => {
  it('creates unique reviewer/chunk siblings with integration-friendly metadata', async () => {
    const workspaces = factory()
    const [first, second] = await Promise.all([
      workspaces.createReviewerWorkspace({ reviewerId: 'security', chunkIndex: 1 }),
      workspaces.createReviewerWorkspace({ reviewerId: 'security', chunkIndex: 1 }),
    ])

    expect(first.path).not.toBe(second.path)
    expect(dirname(first.path)).toBe(root)
    expect(dirname(second.path)).toBe(root)
    expect(first.workspaceKey).toMatch(/^reviewer-security-chunk-1-/)
    expect(first).toMatchObject({
      createdNow: true,
      kind: 'reviewer',
      reviewerId: 'security',
      chunkIndex: 1,
    })
    expect(readFileSync(join(first.path, 'MR.md'), 'utf8')).toBe('# original material\n')
    expect(readFileSync(join(first.path, 'files', 'src', 'feature.ts'), 'utf8')).toContain('"base"')
  })

  it('uses distinct file inodes so one session cannot contaminate the base or another session', async () => {
    const workspaces = factory()
    const general = await workspaces.createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })
    const security = await workspaces.createReviewerWorkspace({ reviewerId: 'security', chunkIndex: 0 })

    writeFileSync(join(general.path, 'MR.md'), '# tampered by general\n')
    writeFileSync(join(general.path, 'files', 'src', 'feature.ts'), 'tampered\n')
    writeFileSync(join(general.path, 'FINDINGS.json'), '{"findings":[]}')

    expect(readFileSync(join(base, 'MR.md'), 'utf8')).toBe('# original material\n')
    expect(readFileSync(join(security.path, 'MR.md'), 'utf8')).toBe('# original material\n')
    expect(readFileSync(join(base, 'files', 'src', 'feature.ts'), 'utf8')).toContain('"base"')
    expect(readFileSync(join(security.path, 'files', 'src', 'feature.ts'), 'utf8')).toContain('"base"')
    expect(existsSync(join(base, 'FINDINGS.json'))).toBe(false)
    expect(existsSync(join(security.path, 'FINDINGS.json'))).toBe(false)
    expect(lstatSync(join(general.path, 'MR.md')).ino).not.toBe(lstatSync(join(base, 'MR.md')).ino)
    expect(lstatSync(join(general.path, 'MR.md')).ino).not.toBe(lstatSync(join(security.path, 'MR.md')).ino)
  })

  it('creates a fresh critic copy from the base, not from reviewer output', async () => {
    const workspaces = factory()
    const reviewer = await workspaces.createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })
    writeFileSync(join(reviewer.path, 'FINDINGS.json'), '{"summary":"reviewer output","findings":[]}')
    writeFileSync(join(reviewer.path, 'MR.md'), 'reviewer changed this')

    const critic = await workspaces.createCriticWorkspace()

    expect(dirname(critic.path)).toBe(root)
    expect(critic.workspaceKey).toMatch(/^critic-/)
    expect(critic).toMatchObject({
      createdNow: true,
      kind: 'critic',
      reviewerId: null,
      chunkIndex: null,
    })
    expect(readFileSync(join(critic.path, 'MR.md'), 'utf8')).toBe('# original material\n')
    expect(existsSync(join(critic.path, 'FINDINGS.json'))).toBe(false)
  })

  it('makes the copy owner-writable even when the immutable base is read-only', async () => {
    const mrPath = join(base, 'MR.md')
    const diffPath = join(base, 'diff')
    const diffSourcePath = join(diffPath, 'src')
    chmodSync(mrPath, 0o400)
    chmodSync(diffPath, 0o500)
    chmodSync(diffSourcePath, 0o500)

    try {
      const reviewer = await factory().createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })

      writeFileSync(join(reviewer.path, 'MR.md'), '# writable session output\n')
      writeFileSync(join(reviewer.path, 'diff', 'new-output.txt'), 'session-only')
      expect(readFileSync(join(reviewer.path, 'MR.md'), 'utf8')).toContain('writable session')
      expect(readFileSync(mrPath, 'utf8')).toBe('# original material\n')
    } finally {
      // Recursive teardown needs write permission on directories in order to
      // unlink their children. Restore the fixture even when an assertion or
      // workspace creation fails.
      chmodSync(diffSourcePath, 0o700)
      chmodSync(diffPath, 0o700)
      chmodSync(mrPath, 0o600)
    }
  })

  it('keeps successful copies until the caller chooses to clean them, then cleans idempotently', async () => {
    const workspaces = factory()
    const preserved = await workspaces.createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })
    const removed = await workspaces.createReviewerWorkspace({ reviewerId: 'security', chunkIndex: 0 })

    expect(existsSync(preserved.path)).toBe(true)
    expect(existsSync(removed.path)).toBe(true)
    await removed.cleanup()
    await removed.cleanup()

    expect(existsSync(removed.path)).toBe(false)
    expect(existsSync(preserved.path)).toBe(true)
    expect(existsSync(base)).toBe(true)
  })
})

describe('path and link safety', () => {
  it('requires the base to be a direct sibling of session destinations', () => {
    const nestedBase = join(root, 'nested', 'base')
    mkdirSync(nestedBase, { recursive: true })
    expect(() => new ReviewSessionWorkspaceFactory({ root, baseWorkspacePath: nestedBase })).toThrow(
      /direct child/,
    )
  })

  it('rejects a base outside the configured root', () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    expect(() => new ReviewSessionWorkspaceFactory({ root, baseWorkspacePath: outside })).toThrow(
      /direct child/,
    )
  })

  it('rejects a symlink used as the base directory', async () => {
    const actualBase = join(root, 'actual-base')
    mkdirSync(actualBase)
    const linkedBase = join(root, 'linked-base')
    symlinkSync(actualBase, linkedBase, 'dir')
    const workspaces = new ReviewSessionWorkspaceFactory({ root, baseWorkspacePath: linkedBase })

    await expect(workspaces.createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })).rejects.toThrow(
      /plain directory|symbolic link/,
    )
  })

  it('rejects a symlink used as the configured workspace root', async () => {
    const actualRoot = join(scratch, 'actual-root')
    const actualBase = join(actualRoot, 'base')
    mkdirSync(actualBase, { recursive: true })
    const linkedRoot = join(scratch, 'linked-root')
    symlinkSync(actualRoot, linkedRoot, 'dir')
    const workspaces = new ReviewSessionWorkspaceFactory({
      root: linkedRoot,
      baseWorkspacePath: join(linkedRoot, 'base'),
    })

    await expect(workspaces.createCriticWorkspace()).rejects.toThrow(/root must be a plain directory/)
  })

  it('rejects links anywhere in material without reading their outside target and removes the partial copy', async () => {
    const secret = join(scratch, 'outside-secret.txt')
    writeFileSync(secret, 'must not be copied')
    symlinkSync(secret, join(base, 'outside-link'))
    const before = new Set(readdirSync(root))

    await expect(factory().createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0 })).rejects.toThrow(
      /Symbolic links are not allowed/,
    )

    expect(new Set(readdirSync(root))).toEqual(before)
    expect(readdirSync(root).some((entry) => entry.startsWith('reviewer-general-chunk-0-'))).toBe(false)
  })

  it('rejects links to directories rather than recursively following them', async () => {
    const outsideDirectory = join(scratch, 'outside-directory')
    mkdirSync(outsideDirectory)
    writeFileSync(join(outsideDirectory, 'secret.txt'), 'must not be copied')
    symlinkSync(outsideDirectory, join(base, 'repo'), 'dir')

    await expect(factory().createCriticWorkspace()).rejects.toThrow(/Symbolic links are not allowed/)
    expect(readdirSync(root).some((entry) => entry.startsWith('critic-'))).toBe(false)
  })

  it('honours cancellation during setup and removes any unusable destination', async () => {
    const controller = new AbortController()
    controller.abort(new Error('review cancelled'))

    await expect(
      factory().createReviewerWorkspace({ reviewerId: 'general', chunkIndex: 0, signal: controller.signal }),
    ).rejects.toThrow(/review cancelled/)
    expect(readdirSync(root)).toEqual(['base'])
  })
})
