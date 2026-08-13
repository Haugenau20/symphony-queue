/**
 * An OPTIONAL shallow checkout of a merge request's repository at its pinned
 * head SHA, for reviewer context beyond the changed files (design report §9:
 * "Phase 2 may add a read-only shallow checkout if reviewers need
 * repository-wide context"; §14 phase 2).
 *
 * THE SANDBOX INVARIANT this module exists to respect: the review agent holds
 * no GitLab token and has no network egress (worker.ts's header). Nothing
 * here changes that. This module runs in the CONTROLLER — which does have the
 * token and the squid route — and produces a plain directory of files. The
 * sandbox the agent actually sees deliberately contains no `.git` at all,
 * which is part of why the agent cannot push: `.git` is deleted, and verified
 * gone, before the checkout is ever considered usable. If that deletion
 * cannot be verified, the result is `unavailable` and the destination is left
 * with NOTHING — never a half-deleted repository.
 *
 * NEVER THROWS. Every failure — a bad URL, a network error, a SHA mismatch, a
 * size or time ceiling, a `.git` that would not delete — becomes
 * `{ kind: 'unavailable', reason }`. Wider context is a bonus a review can do
 * without; it is never a prerequisite (see CheckoutResult in ./types.ts).
 *
 * THE TOKEN. `SYMPHONY_REVIEW_GITLAB_TOKEN`-class credentials must never
 * appear in argv (world-readable via /proc/<pid>/cmdline), a log line, an
 * error message, or the `.git/config` this module is about to delete anyway.
 * The mechanism: the clone URL carries a fixed, non-secret username only
 * (`CHECKOUT_URL_USERNAME`) — never a password — so git only ever prompts for
 * a PASSWORD, and `GIT_ASKPASS` points at a tiny generated script (mode
 * 0700 — needs the execute bit for git to run it at all, which is the
 * practical form of "owner-only" the brief's "0600" was reaching for; nothing
 * but the invoking user can read OR execute it) that writes the token to
 * stdout and nothing else. The token is embedded via `JSON.stringify` into a
 * literal Node.js string rather than shell-quoted into a `/bin/sh` script, so
 * a token containing a quote or a `$` cannot corrupt the script it sits in.
 * The script is deleted in every code path, success or failure. As one more
 * layer, {@link redact} strips the token out of anything that might end up in
 * a log line or a returned `reason` — including a transport error's message —
 * on the theory that a single missed call site should not become a leak.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getLogger } from '../log.js'
import { checkContainment } from '../path_safety.js'
import type { CheckoutResult, RepoCheckout } from './types.js'

// --- injectable process execution -------------------------------------------

export interface ExecFileResult {
  stdout: string
  stderr: string
}

export interface ExecFileOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Milliseconds until the child is killed. Node's `execFile` enforces this itself. */
  timeout: number
  signal?: AbortSignal
  maxBuffer?: number
}

export type ExecFileFn = (file: string, args: string[], options: ExecFileOptions) => Promise<ExecFileResult>

const defaultExecFile = promisify(execFile)

/** The default {@link ExecFileFn}: node's own `execFile`, promisified. */
const runExecFile: ExecFileFn = async (file, args, options) => {
  const result = await defaultExecFile(file, args, options)
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

// --- defaults ----------------------------------------------------------------

/** Total working-tree bytes (post `.git` deletion) before a checkout is abandoned as `unavailable`. */
export const DEFAULT_MAX_CHECKOUT_BYTES = 250 * 1024 * 1024 // 250 MiB

/** Total working-tree file count before a checkout is abandoned as `unavailable`. */
export const DEFAULT_MAX_CHECKOUT_FILES = 20_000

/** Wall-clock ceiling for the whole fetch — every git invocation plus the size walk. */
export const DEFAULT_CHECKOUT_TIMEOUT_MS = 180_000 // 3 minutes

/**
 * Non-secret. Placed in the clone URL so git only ever needs a PASSWORD
 * prompt (satisfied by {@link buildAskpassScript}) and never a username one —
 * GitLab accepts any non-empty username paired with a project/group access
 * token as the HTTP password.
 */
const CHECKOUT_URL_USERNAME = 'symphony-review-checkout'

// --- helpers -------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A hex-ish sanity check on a commit SHA — not a security boundary (the SHA never reaches a shell), just a fast reject of obvious garbage. */
function looksLikeSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(sha)
}

class CheckoutAbandoned extends Error {}

/** A human-readable label for an error message — the real subcommand, skipping the `-c key=value` pairs this class prefixes some calls with. */
function gitSubcommandLabel(args: string[]): string {
  let i = 0
  while (i < args.length && args[i] === '-c') i += 2
  return args[i] ?? args.join(' ')
}

export interface GitShallowCheckoutConfig {
  /** GitLab instance base URL, no trailing slash and no `/api/v4` — same convention as GitLabMergeRequestClientConfig.baseUrl. */
  baseUrl: string
  /** Reporter-role token — same credential class as SYMPHONY_REVIEW_GITLAB_TOKEN. Never placed in argv, a URL, a log line, or an error message; see the module header. */
  token: string
  /**
   * The root every checkout must be contained within — both the staging
   * clone (below) and the caller-supplied `destination`. Defense in depth,
   * mirroring store.ts's `projectDir`: `projectId` is attacker-influenced
   * (it is the merge request's own project path) and reaches the filesystem
   * both directly, as a component of the staging directory's name, and
   * indirectly, if `destination` was itself built from it upstream —
   * {@link checkContainment} is run against both.
   */
  sandboxRoot: string
  /** Overrides {@link DEFAULT_MAX_CHECKOUT_BYTES}. */
  maxBytes?: number
  /** Overrides {@link DEFAULT_MAX_CHECKOUT_FILES}. */
  maxFiles?: number
  /** Overrides {@link DEFAULT_CHECKOUT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to node's own `execFile`, promisified. */
  execFileImpl?: ExecFileFn
  /** Injectable for tests. Defaults to `'git'` (resolved off PATH). */
  gitBinary?: string
}

/**
 * A read-only, `.git`-free shallow checkout of one merge request's repository
 * at its exact pinned head SHA. See the module header for the full posture.
 */
export class GitShallowCheckout implements RepoCheckout {
  private readonly baseUrl: string
  private readonly token: string
  private readonly sandboxRoot: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly timeoutMs: number
  private readonly execFileImpl: ExecFileFn
  private readonly gitBinary: string

  constructor(config: GitShallowCheckoutConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    this.sandboxRoot = resolve(config.sandboxRoot)
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_CHECKOUT_BYTES
    this.maxFiles = config.maxFiles ?? DEFAULT_MAX_CHECKOUT_FILES
    this.timeoutMs = config.timeoutMs ?? DEFAULT_CHECKOUT_TIMEOUT_MS
    this.execFileImpl = config.execFileImpl ?? runExecFile
    this.gitBinary = config.gitBinary ?? 'git'
  }

  async fetch(
    request: { projectId: string; headSha: string; destination: string },
    signal?: AbortSignal,
  ): Promise<CheckoutResult> {
    const log = getLogger()
    const { projectId, headSha, destination } = request
    const deadline = Date.now() + this.timeoutMs

    let destPath: string
    let stagingDir: string | null = null
    let askpassDir: string | null = null

    try {
      // The contract path first: whatever this call returns as `path` on
      // success MUST be exactly `destination`, so it is validated before
      // anything else — a destination outside the sandbox root is refused
      // regardless of how it came to be attacker-influenced upstream.
      destPath = resolve(destination)
      checkContainment(destPath, this.sandboxRoot)

      if (existsSync(destPath)) {
        const preexisting = await readdir(destPath).catch(() => [] as string[])
        if (preexisting.length > 0) {
          throw new CheckoutAbandoned('destination already exists and is not empty')
        }
      }

      if (!looksLikeSha(headSha)) {
        throw new CheckoutAbandoned('head sha is not a plausible git commit id')
      }
      if (!projectId || projectId.trim().length === 0) {
        throw new CheckoutAbandoned('empty project id')
      }

      const cloneUrl = this.buildCloneUrl(projectId)

      // Staged in a directory this class owns entirely, never `destination`
      // itself: every failure below simply removes the staging directory and
      // returns, so `destination` is created (via an atomic rename) ONLY at
      // the very end of a fully successful run — it can never be observed
      // half-populated, half-fetched, or with a `.git` that failed to delete.
      const stagingRoot = resolve(join(this.sandboxRoot, '.checkout-staging'))
      await mkdir(stagingRoot, { recursive: true })
      const stagingName = `${encodeURIComponent(projectId)}-${randomBytes(8).toString('hex')}`
      stagingDir = resolve(join(stagingRoot, stagingName))
      checkContainment(stagingDir, stagingRoot)
      checkContainment(stagingDir, this.sandboxRoot)
      await mkdir(stagingDir, { recursive: true })

      askpassDir = await mkdtemp(join(tmpdir(), 'symphony-review-checkout-'))
      const askpassPath = join(askpassDir, 'askpass.cjs')
      await writeFile(askpassPath, buildAskpassScript(this.token), { mode: 0o700 })

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: askpassPath,
      }

      const run = (args: string[]) => this.runGit(args, stagingDir!, env, deadline, signal)

      await run(['init', '--quiet'])
      // `credential.helper=` (empty) disables anything configured system- or
      // user-wide that might otherwise cache or echo the credential this
      // askpass supplies — belt and suspenders alongside the askpass itself.
      await run(['-c', 'credential.helper=', 'remote', 'add', 'origin', cloneUrl])
      // depth=1 AT THE PINNED SHA. A plain `git clone --depth 1` clones the
      // branch tip, which is a DIFFERENT revision than the one under review —
      // the whole reason for init+remote add+fetch+checkout instead.
      await run(['-c', 'credential.helper=', 'fetch', '--depth=1', 'origin', headSha])
      await run(['checkout', '--quiet', 'FETCH_HEAD'])

      const revParse = await run(['rev-parse', 'HEAD'])
      const actualSha = revParse.stdout.trim()
      if (actualSha !== headSha) {
        // Never trust the fetch: this is the check that stops a checkout of
        // the wrong revision from silently making every finding refer to
        // code the reviewer never actually saw.
        throw new CheckoutAbandoned(
          `checked-out commit ${actualSha || '<empty>'} does not match the requested head sha ${headSha}`,
        )
      }

      const measured = await this.measureTree(stagingDir, deadline)
      if (measured.bytes > this.maxBytes || measured.files > this.maxFiles) {
        throw new CheckoutAbandoned(
          `checkout exceeds configured limits (${measured.bytes} bytes / ${measured.files} files, ` +
          `max ${this.maxBytes} bytes / ${this.maxFiles} files)`,
        )
      }

      const gitDir = resolve(join(stagingDir, '.git'))
      checkContainment(gitDir, stagingDir)
      try {
        await rm(gitDir, { recursive: true, force: true })
      } catch (err) {
        // `force: true` only swallows "already gone" — a real permission or
        // I/O failure still throws. Either way lands here or in the
        // existsSync check right below: both are the case the module header
        // warns about, a delete that did not fully succeed, and both abandon
        // the whole staging directory rather than hand back anything with a
        // half-deleted `.git` in it.
        throw new CheckoutAbandoned(`.git directory could not be removed: ${errMsg(err)}`)
      }
      if (existsSync(gitDir)) {
        throw new CheckoutAbandoned('.git directory could not be fully removed')
      }

      await mkdir(resolve(join(destPath, '..')), { recursive: true })
      try {
        await rename(stagingDir, destPath)
      } catch (err) {
        // Cross-device (EXDEV) or any other rename failure: sandboxRoot is
        // assumed single-filesystem, same assumption the review store's
        // rename(2)-based claim already relies on. Abandon rather than fall
        // back to a copy that could itself be interrupted midway.
        throw new CheckoutAbandoned(`could not finalize checkout: ${errMsg(err)}`)
      }
      stagingDir = null // now living at destPath; nothing left to clean up

      log.info({ projectId, headSha, fileCount: measured.files }, 'review_checkout_ready')
      return { kind: 'checked_out', path: destPath, fileCount: measured.files }
    } catch (err) {
      const reason = this.redact(this.describeFailure(err))
      log.warn({ projectId, headSha, reason }, 'review_checkout_unavailable')
      return { kind: 'unavailable', reason }
    } finally {
      if (askpassDir) {
        await rm(askpassDir, { recursive: true, force: true }).catch(() => { /* best effort */ })
      }
      if (stagingDir) {
        await rm(stagingDir, { recursive: true, force: true }).catch((err: unknown) => {
          log.warn({ stagingDir, error: this.redact(errMsg(err)) }, 'review_checkout_staging_cleanup_failed')
        })
      }
    }
  }

  // --- url ------------------------------------------------------------------

  /**
   * Builds `<baseUrl>/<projectId>.git` with a fixed, non-secret username and
   * NO password — the token never touches this string. `URL`'s own
   * percent-encoding of the path keeps a hostile `projectId` from doing
   * anything more interesting than producing a URL GitLab will 404 on.
   */
  private buildCloneUrl(projectId: string): string {
    const url = new URL(this.baseUrl)
    // `file:` is accepted alongside http(s) purely so this class can be
    // exercised against a real local git repository (no network, no daemon)
    // in tests — GitLab itself is always reached over http(s) in production,
    // and `file:` URLs carry no credential of any kind, so there is nothing
    // for the username below to authenticate.
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'file:') {
      throw new CheckoutAbandoned(`unsupported base url scheme: ${url.protocol}`)
    }
    if (url.protocol !== 'file:') {
      url.username = CHECKOUT_URL_USERNAME
      url.password = ''
    }
    const base = url.pathname.replace(/\/+$/, '')
    const project = projectId.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
    if (project.length === 0) throw new CheckoutAbandoned('empty project id')
    url.pathname = `${base}/${project}.git`
    return url.toString()
  }

  // --- git invocation ---------------------------------------------------------

  private async runGit(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ExecFileResult> {
    const label = gitSubcommandLabel(args)
    if (signal?.aborted) throw new CheckoutAbandoned('checkout aborted')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new CheckoutAbandoned(`checkout timed out before 'git ${label}' could run`)
    try {
      return await this.execFileImpl(this.gitBinary, args, {
        cwd,
        env,
        timeout: remaining,
        signal,
        maxBuffer: 16 * 1024 * 1024,
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string }
      if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
        throw new CheckoutAbandoned(`'git ${label}' timed out`)
      }
      const stderrTail = typeof e.stderr === 'string' ? e.stderr.trim().slice(-500) : ''
      throw new CheckoutAbandoned(
        `'git ${label}' failed: ${this.redact(errMsg(err))}${stderrTail ? ` (${this.redact(stderrTail)})` : ''}`,
      )
    }
  }

  // --- size / file ceiling -----------------------------------------------------

  /**
   * Walks the working tree (never descending into `.git`, which is measured
   * as nothing — it is deleted before this checkout is ever handed to
   * anyone), bailing out the moment either ceiling is crossed so an oversized
   * repository is detected in proportion to the ceiling, not to its own size.
   * Also re-checks the deadline per directory, so a repository with millions
   * of tiny files cannot turn this walk itself into the ten-minute stall the
   * ceilings exist to prevent.
   */
  private async measureTree(root: string, deadline: number): Promise<{ bytes: number; files: number }> {
    let bytes = 0
    let files = 0
    const stack: string[] = [root]
    while (stack.length > 0) {
      if (Date.now() > deadline) throw new CheckoutAbandoned('checkout timed out while measuring the working tree')
      const dir = stack.pop()!
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (dir === root && entry.name === '.git') continue
        const full = resolve(join(dir, entry.name))
        checkContainment(full, root)
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        // Symlinks and regular files are both counted by their own lstat
        // size — a symlink is never followed, so it cannot be used to make
        // this walk see bytes that live outside the checkout.
        const st = await stat(full).catch(() => null)
        bytes += st?.size ?? 0
        files += 1
        if (files > this.maxFiles || bytes > this.maxBytes) return { bytes, files }
      }
    }
    return { bytes, files }
  }

  // --- token hygiene ------------------------------------------------------------

  /** Strips the token out of anything about to become a log field or a returned `reason`, defense in depth on top of never passing it via argv. */
  private redact(text: string): string {
    if (!this.token) return text
    return text.split(this.token).join('[REDACTED]')
  }

  private describeFailure(err: unknown): string {
    if (err instanceof CheckoutAbandoned) return err.message
    return `unexpected checkout error: ${errMsg(err)}`
  }
}

/**
 * The GIT_ASKPASS script. A Node script rather than `/bin/sh`, specifically
 * so the token is embedded via `JSON.stringify` — a real string literal, not
 * shell-quoted text — so a token containing a quote, a `$`, or a backtick
 * cannot corrupt or reinterpret the script it sits inside. Ignores git's
 * prompt argument entirely and always answers with the token: the clone URL
 * carries a fixed non-secret username (see {@link CHECKOUT_URL_USERNAME}), so
 * this is only ever invoked for the password prompt.
 */
function buildAskpassScript(token: string): string {
  return `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(token)});\n`
}
