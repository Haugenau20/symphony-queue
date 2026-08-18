import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { getLogger } from '../../src/log.js'
import {
  GitShallowCheckout,
  DEFAULT_MAX_CHECKOUT_BYTES,
  DEFAULT_MAX_CHECKOUT_FILES,
  type ExecFileFn,
  type ExecFileResult,
} from '../../src/review/checkout.js'

// `rm` is mocked at the module level (below) so ONE test can force a
// `.git`-deletion failure without touching real filesystem permissions —
// vitest cannot spy on a live ESM named export directly ("module namespace
// is not configurable"), so this is the supported way to make one call fail
// on demand while every other `fs/promises.rm` call in this file (including
// the ones inside checkout.ts itself, and this file's own cleanup) behaves
// normally.
const rmControl = vi.hoisted(() => ({ failPathSuffix: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (path: unknown, options?: unknown) => {
      if (rmControl.failPathSuffix && String(path).endsWith(rmControl.failPathSuffix)) {
        throw new Error('EPERM: simulated deletion failure')
      }
      return actual.rm(path as never, options as never)
    },
  }
})

const TOKEN = 'glpat-SUPER-SECRET-REVIEW-TOKEN-99999'
const realExecFile: ExecFileFn = async (file, args, options) => {
  const result = await promisify(execFile)(file, args, options)
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

let sandboxRoot: string
let instanceRoot: string

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'symphony-checkout-sandbox-'))
  instanceRoot = mkdtempSync(join(tmpdir(), 'symphony-checkout-origin-'))
  rmControl.failPathSuffix = null
})

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true })
  rmSync(instanceRoot, { recursive: true, force: true })
  rmControl.failPathSuffix = null
  vi.restoreAllMocks()
})

// --- fixture: a real local git repository with two commits -----------------
//
// Lives at `<instanceRoot>/repo.git` so that `GitShallowCheckout`'s own URL
// construction (`<baseUrl>/<projectId>.git`) resolves to it exactly the same
// way it would resolve a real GitLab project path — this exercises the
// production URL-building code path, not a substitute for it.

function repoDir(): string {
  return join(instanceRoot, 'repo.git')
}

function gitFixture(dir: string) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, env }).toString()
  run(['init', '--quiet'])
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  run(['add', 'a.txt'])
  run(['commit', '--quiet', '-m', 'first'])
  const sha1 = run(['rev-parse', 'HEAD']).trim()
  writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'b.txt'), 'nested\n')
  run(['add', '-A'])
  run(['commit', '--quiet', '-m', 'second'])
  const sha2 = run(['rev-parse', 'HEAD']).trim()
  return { sha1, sha2 }
}

function checkout(overrides: Partial<ConstructorParameters<typeof GitShallowCheckout>[0]> = {}): GitShallowCheckout {
  return new GitShallowCheckout({
    baseUrl: `file://${instanceRoot}`,
    token: TOKEN,
    sandboxRoot,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------

describe('successful checkout', () => {
  it('checks out the exact pinned SHA, deletes .git, and returns the file count', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    const gc = checkout()

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('checked_out')
    if (result.kind !== 'checked_out') throw new Error('unreachable')
    expect(result.path).toBe(destination)
    expect(result.fileCount).toBe(1) // sha1 has only a.txt
    expect(existsSync(join(destination, 'a.txt'))).toBe(true)
    expect(readFileSync(join(destination, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('.git is absent from the destination on success — asserted on the filesystem, not a flag', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    const gc = checkout()

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('checked_out')
    expect(existsSync(join(destination, '.git'))).toBe(false)
    expect(readdirSync(destination)).not.toContain('.git')
  })

  it('checks out the OLDER pinned sha, not the branch tip — proving depth=1 targets the exact commit', async () => {
    const { sha1, sha2 } = gitFixture(repoDir())
    expect(sha1).not.toBe(sha2)
    const destination = join(sandboxRoot, 'work')
    const gc = checkout()

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('checked_out')
    // sha2 added sub/b.txt; a checkout of the branch tip would include it.
    expect(existsSync(join(destination, 'sub', 'b.txt'))).toBe(false)
  })

  it('cleans up its own staging and askpass scratch directories after a successful run', async () => {
    const { sha1 } = gitFixture(repoDir())
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('symphony-review-checkout-'))
    const gc = checkout()
    await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('symphony-review-checkout-'))
    expect(after.length).toBe(before.length)
    expect(existsSync(join(sandboxRoot, '.checkout-staging'))).toBe(true)
    expect(readdirSync(join(sandboxRoot, '.checkout-staging')).length).toBe(0)
  })
})

// --- the token ---------------------------------------------------------------

describe('the token never appears in argv', () => {
  it('captures the exact argument vector passed to every git invocation and finds no trace of the token', async () => {
    const { sha1 } = gitFixture(repoDir())
    const calls: Array<{ file: string; args: string[] }> = []
    const recording: ExecFileFn = async (file, args, options) => {
      calls.push({ file, args: [...args] })
      return realExecFile(file, args, options)
    }
    const gc = checkout({ execFileImpl: recording })

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })

    expect(result.kind).toBe('checked_out')
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.file).not.toContain(TOKEN)
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN)
      }
    }
  })
})

describe('the token never appears in argv — over HTTPS, the transport production actually uses', () => {
  // The test above proves this against a file:// fixture, which is the only
  // transport that can be exercised without a network. But buildCloneUrl adds
  // credentials ONLY for http(s) — file:// URLs carry none, so that test walks
  // straight past the branch where a token could ever enter a URL, and passes
  // whether or not the protection exists. Putting the token into the clone URL
  // (the classic /proc argv leak) left the entire suite green.
  //
  // So this one drives the https path with a git that never really runs: the
  // first invocation records its argv and fails, which is enough, because
  // 'remote add origin <url>' is where the URL becomes an argument.
  it('an https base url puts no credential in the remote URL or any argument', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    // Succeeds until the network is actually needed, so `remote add origin
    // <url>` — the invocation that puts the URL into argv — is reached and
    // recorded before anything fails.
    const recording: ExecFileFn = async (file, args) => {
      calls.push({ file, args: [...args] })
      if (args.includes('fetch')) {
        throw new Error('exit status 128: fatal: unable to access remote')
      }
      return { stdout: '', stderr: '' }
    }
    const gc = checkout({
      baseUrl: 'https://gitlab.internal.example',
      execFileImpl: recording,
    })

    const result = await gc.fetch({
      projectId: 'my-org/service-a',
      headSha: 'a'.repeat(40),
      destination: join(sandboxRoot, 'https-work'),
    })

    // The point is the argv, not the outcome — a fetch that cannot reach the
    // remote is 'unavailable', which is correct and beside the point here.
    expect(result.kind).toBe('unavailable')

    const remoteAdd = calls.find((c) => c.args.includes('remote'))
    expect(remoteAdd, 'expected a `git remote add` invocation to inspect').toBeDefined()
    // The URL is in there somewhere; it must name the host and not the token.
    expect(remoteAdd!.args.join(' ')).toContain('gitlab.internal.example')

    for (const call of calls) {
      expect(call.file).not.toContain(TOKEN)
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN)
      }
    }
  })
})

describe('the token never appears in a log line or an unavailable reason', () => {
  it('is absent from the returned reason when the underlying git call fails outright', async () => {
    const failing: ExecFileFn = async () => {
      throw new Error('exit status 128: fatal: could not read from remote repository')
    }
    const gc = checkout({ execFileImpl: failing })

    const result = await gc.fetch({
      projectId: 'repo',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      destination: join(sandboxRoot, 'work'),
    })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).not.toContain(TOKEN)
  })

  it('redacts the token even when the underlying error message happens to contain it — the leaking case', async () => {
    // Simulates the failure mode the module is built to avoid: some transport
    // layer echoing the credential back in an error. The redaction is a
    // second, independent layer on top of "never put it in argv" for exactly
    // this reason.
    const leaking: ExecFileFn = async () => {
      throw new Error(`fatal: authentication failed for url containing token ${TOKEN}`)
    }
    const gc = checkout({ execFileImpl: leaking })

    const result = await gc.fetch({
      projectId: 'repo',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      destination: join(sandboxRoot, 'work'),
    })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).not.toContain(TOKEN)
    expect(result.reason).toContain('[REDACTED]')
  })

  it('never logs the token, including on a failing run', async () => {
    const log = getLogger()
    const warnSpy = vi.spyOn(log, 'warn')
    const infoSpy = vi.spyOn(log, 'info')
    const leaking: ExecFileFn = async () => {
      throw new Error(`boom ${TOKEN} boom`)
    }
    const gc = checkout({ execFileImpl: leaking })

    await gc.fetch({
      projectId: 'repo',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      destination: join(sandboxRoot, 'work'),
    })

    for (const call of [...warnSpy.mock.calls, ...infoSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN)
    }
  })

  it('never logs the token on a successful run either', async () => {
    const { sha1 } = gitFixture(repoDir())
    const log = getLogger()
    const warnSpy = vi.spyOn(log, 'warn')
    const infoSpy = vi.spyOn(log, 'info')
    const gc = checkout()

    await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })

    for (const call of [...warnSpy.mock.calls, ...infoSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN)
    }
  })
})

// --- SHA verification --------------------------------------------------------

describe('SHA verification', () => {
  it('a HEAD that does not match the requested SHA returns unavailable and leaves no repo directory behind', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    // Let every real git call through, but lie about the final rev-parse so
    // the checked-out commit looks like it does not match what was asked for.
    const spoofing: ExecFileFn = async (file, args, options) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'ffffffffffffffffffffffffffffffffffffff\n', stderr: '' }
      }
      return realExecFile(file, args, options)
    }
    const gc = checkout({ execFileImpl: spoofing })

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason.toLowerCase()).toContain('does not match')
    expect(existsSync(destination)).toBe(false)
  })
})

// --- containment / hostile input ---------------------------------------------

describe('hostile input cannot escape the sandbox root', () => {
  it('a destination outside sandboxRoot is refused before anything is written, and nothing is created outside it', async () => {
    const { sha1 } = gitFixture(repoDir())
    const escapee = join(sandboxRoot, '..', 'symphony-checkout-escape-test')
    rmSync(escapee, { recursive: true, force: true })
    const gc = checkout()

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination: escapee })

    expect(result.kind).toBe('unavailable')
    expect(existsSync(escapee)).toBe(false)
    rmSync(escapee, { recursive: true, force: true })
  })

  it('a hostile projectId ("../../etc") cannot escape the sandbox root and does not throw', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    const gc = checkout()

    // Whatever this resolves to as a git remote URL, it must not touch the
    // filesystem outside sandboxRoot, and the call must resolve normally
    // rather than throwing.
    const result = await gc.fetch({ projectId: '../../etc', headSha: sha1, destination })
    expect(['checked_out', 'unavailable']).toContain(result.kind)
    expect(existsSync('/etc/symphony-checkout-hostile-marker')).toBe(false)
  })

  it('refuses a destination that already exists and has content, without throwing', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'pre-existing.txt'), 'do not touch')
    const gc = checkout()

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('unavailable')
    expect(existsSync(join(destination, 'pre-existing.txt'))).toBe(true)
  })
})

// --- .git deletion failure ----------------------------------------------------

describe('a failed .git delete', () => {
  it('yields unavailable and leaves no partial repo directory behind', async () => {
    const { sha1 } = gitFixture(repoDir())
    const destination = join(sandboxRoot, 'work')
    rmControl.failPathSuffix = '.git'

    const gc = checkout()
    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).toContain('.git')
    expect(existsSync(destination)).toBe(false)

    // The simulated failure prevented THAT ONE rm from succeeding, but the
    // class must still have discarded the whole staging directory (via a
    // second, un-intercepted rm on the staging dir itself) on the way out —
    // no partial clone left behind anywhere.
    rmControl.failPathSuffix = null
    const stagingRoot = join(sandboxRoot, '.checkout-staging')
    if (existsSync(stagingRoot)) {
      expect(readdirSync(stagingRoot).length).toBe(0)
    }
  })
})

// --- ceilings ------------------------------------------------------------------

describe('size and file ceilings', () => {
  it('exceeding the byte ceiling returns unavailable and does not throw', async () => {
    const { sha1 } = gitFixture(repoDir())
    const gc = checkout({ maxBytes: 1 })

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).toMatch(/limit/i)
    expect(existsSync(join(sandboxRoot, 'work'))).toBe(false)
  })

  it('exceeding the file-count ceiling returns unavailable and does not throw', async () => {
    const { sha1 } = gitFixture(repoDir())
    const gc = checkout({ maxFiles: 0 })

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })

    expect(result.kind).toBe('unavailable')
    expect(existsSync(join(sandboxRoot, 'work'))).toBe(false)
  })

  it('default ceilings are sane positive numbers', () => {
    expect(DEFAULT_MAX_CHECKOUT_BYTES).toBeGreaterThan(0)
    expect(DEFAULT_MAX_CHECKOUT_FILES).toBeGreaterThan(0)
  })
})

// --- timeout -------------------------------------------------------------------

describe('timeout', () => {
  it('an already-elapsed deadline returns unavailable and does not throw, before spawning anything', async () => {
    const { sha1 } = gitFixture(repoDir())
    const gc = checkout({ timeoutMs: 0 })

    const result = await gc.fetch({ projectId: 'repo', headSha: sha1, destination: join(sandboxRoot, 'work') })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason.toLowerCase()).toContain('timed out')
    expect(existsSync(join(sandboxRoot, 'work'))).toBe(false)
  })

  it('a git process killed for exceeding its timeout is reported as unavailable, not thrown', async () => {
    const timingOut: ExecFileFn = async (): Promise<ExecFileResult> => {
      const err = new Error('command timed out') as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
      err.killed = true
      err.signal = 'SIGTERM'
      throw err
    }
    const gc = checkout({ execFileImpl: timingOut })

    const result = await gc.fetch({
      projectId: 'repo',
      headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      destination: join(sandboxRoot, 'work'),
    })

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    expect(result.reason.toLowerCase()).toContain('timed out')
  })
})

// --- never throws --------------------------------------------------------------

describe('never throws', () => {
  it('an execFileImpl that rejects with a non-Error value is still reported as unavailable', async () => {
    const weird: ExecFileFn = async () => {
      throw 'a plain string rejection'
    }
    const gc = checkout({ execFileImpl: weird })

    await expect(
      gc.fetch({
        projectId: 'repo',
        headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        destination: join(sandboxRoot, 'work'),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('an unparseable base url is reported as unavailable rather than thrown', async () => {
    const gc = checkout({ baseUrl: 'not a url at all' })

    await expect(
      gc.fetch({
        projectId: 'repo',
        headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        destination: join(sandboxRoot, 'work'),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('an implausible head sha is refused without ever invoking git', async () => {
    const calls: string[][] = []
    const recording: ExecFileFn = async (_file, args) => {
      calls.push(args)
      throw new Error('should not be called')
    }
    const gc = checkout({ execFileImpl: recording })

    const result = await gc.fetch({ projectId: 'repo', headSha: 'not-a-sha!!', destination: join(sandboxRoot, 'work') })

    expect(result.kind).toBe('unavailable')
    expect(calls.length).toBe(0)
  })
})
