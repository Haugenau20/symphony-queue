import { fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit } from 'undici'
import { proxyFromEnv, describeCause } from '../tracker/gitlab.js'
import { getLogger } from '../log.js'
import { isCollapsedDiff } from './diff.js'
import type { MergeRequestClient, MergeRequestDiffFile, MergeRequestSummary } from './types.js'

/**
 * Reads (and, for notes, writes) merge requests. Deliberately not built on
 * GitLabTracker or TrackerAdapter — this is a different resource (merge
 * requests, not issues) reached with a different credential
 * (`SYMPHONY_REVIEW_GITLAB_TOKEN`, design §11), and forcing it through an
 * issue-shaped interface is exactly what this design avoids.
 *
 * The transport posture is copied from tracker/gitlab.ts on purpose:
 *  - `fetchImpl` is injectable and defaults to undici's fetch.
 *  - the proxy is a scoped `ProxyAgent` passed per-request via `dispatcher`,
 *    never installed as undici's global dispatcher (a global dispatcher would
 *    also redirect the OpenCode server traffic, which must stay direct).
 *  - every request carries `AbortSignal.timeout`.
 *  - errors never include the response body: a GitLab error page can echo
 *    the request that produced it, and the token travels in the
 *    `PRIVATE-TOKEN` header, never the URL.
 */

// --- raw GitLab response shapes ---------------------------------------------
// Only the fields this client reads. Everything else in the payload is
// ignored. Shapes marked GUESSED were not checked against a live instance —
// see the implementation report for what to verify.

interface RawDiffRefs {
  base_sha?: string | null
  start_sha?: string | null
  head_sha?: string | null
}

interface RawMergeRequestListItem {
  iid: number
  project_id?: number | string
  /** GUESSED: used to recover the full project path from a group-level listing. */
  references?: { full?: string | null } | null
}

interface RawMergeRequest {
  iid: number
  title: string
  description?: string | null
  draft?: boolean | null
  work_in_progress?: boolean | null
  source_project_id?: number | null
  target_project_id?: number | null
  state: string
  web_url?: string | null
  updated_at: string
  diff_refs?: RawDiffRefs | null
}

interface RawDiffFile {
  old_path: string
  new_path: string
  diff?: string | null
  new_file?: boolean | null
  renamed_file?: boolean | null
  deleted_file?: boolean | null
  /** GUESSED: not present on older GitLab versions; treated as false when absent. */
  generated_file?: boolean | null
}

/**
 * The `/changes` response. Same per-file shape as `/diffs`, wrapped in an
 * object rather than returned as a bare array, plus `overflow` for "the change
 * list was truncated".
 */
interface RawChangesResponse {
  changes?: RawDiffFile[]
  overflow?: boolean | null
}

interface RawNote {
  id: number | string
  body: string
}

/**
 * Whether a `/diffs` failure means "this instance cannot serve that endpoint"
 * as opposed to "something is wrong that another endpoint will not fix".
 *
 * 404 — absent on this version. 5xx — present and broken, which GitLab 17.5.1
 * demonstrably is for some merge requests. Anything else (401, 403, 429, a
 * transport error) is a real fault: falling back would hide it and produce a
 * confusing second failure instead of the true one.
 */
export function isDiffsEndpointUnusable(err: unknown): boolean {
  if (!(err instanceof GitLabApiError)) return false
  return err.status === 404 || err.status >= 500
}

// --- errors -------------------------------------------------------------------

/**
 * Carries the HTTP status so callers (getMergeRequest's 404-means-gone case)
 * can branch on it without ever inspecting the response body — the message is
 * built the same status-only way as GitLabTracker's request().
 */
export class GitLabApiError extends Error {
  readonly status: number
  constructor(status: number, method: string, path: string) {
    super(`GitLab API ${method} ${path} returned ${status}`)
    this.name = 'GitLabApiError'
    this.status = status
  }
}

// --- mapping ------------------------------------------------------------------

/**
 * `references.full` looks like `"group/project!123"`; the project path is
 * everything before the last `!`. GUESSED shape — falls back to the numeric
 * `project_id` (still a valid GitLab project identifier for later calls, just
 * not the human-readable path) when the field is missing or unrecognized.
 */
export function projectPathFromListItem(raw: RawMergeRequestListItem): string {
  const full = raw.references?.full
  if (typeof full === 'string') {
    const idx = full.lastIndexOf('!')
    if (idx > 0) return full.slice(0, idx)
  }
  return String(raw.project_id)
}

export function mapMergeRequestSummary(raw: RawMergeRequest, projectId: string): MergeRequestSummary {
  const diffRefs = raw.diff_refs
  const ready = Boolean(diffRefs && typeof diffRefs.head_sha === 'string' && diffRefs.head_sha.length > 0)
  return {
    projectId,
    mrIid: raw.iid,
    headSha: ready ? diffRefs!.head_sha! : '',
    baseSha: ready ? diffRefs!.base_sha ?? '' : '',
    startSha: ready ? diffRefs!.start_sha ?? '' : '',
    title: raw.title,
    description: raw.description ?? null,
    draft: Boolean(raw.draft),
    isFork: raw.source_project_id !== raw.target_project_id,
    state: raw.state,
    webUrl: raw.web_url ?? null,
    updatedAt: new Date(raw.updated_at),
  }
}

export function mapDiffFile(raw: RawDiffFile): MergeRequestDiffFile {
  const diff = raw.diff ?? ''
  const deletedFile = Boolean(raw.deleted_file)
  return {
    oldPath: raw.old_path,
    newPath: raw.new_path,
    diff,
    newFile: Boolean(raw.new_file),
    renamedFile: Boolean(raw.renamed_file),
    deletedFile,
    generatedFile: Boolean(raw.generated_file),
    collapsed: isCollapsedDiff({ diff, deletedFile }),
  }
}

// --- client ---------------------------------------------------------------

export interface GitLabMergeRequestClientConfig {
  /** Instance base URL, no trailing slash and no `/api/v4`. */
  baseUrl: string
  /** Read from the environment by the caller, never from the workflow file (design §11). */
  token: string
  /** Group id or URL-encoded path. Watches every project in the group with one poll call. */
  group?: string
  /** Explicit project list, used only when `group` is not set (design §7). */
  projects?: string[]
  requestTimeoutMs?: number
  /** Proxy for GitLab traffic. Defaults to the environment; pass `null` to force direct. */
  proxyUrl?: string | null
  /** Injectable for tests. Defaults to undici's fetch, which honours `dispatcher`. */
  fetchImpl?: typeof undiciFetch
  /**
   * Which endpoint supplies a merge request's changed files.
   *
   * `auto` (default) tries `/diffs` and falls back to `/changes` for the life of
   * the client if the instance answers 404 or 5xx. `changes` skips the probe
   * entirely — useful on an instance known not to serve `/diffs`. `diffs`
   * forces the modern endpoint and surfaces its failure instead of falling back.
   */
  diffEndpoint?: 'auto' | 'diffs' | 'changes'
}

const MAX_PAGES = 20
const PER_PAGE = 100

export class GitLabMergeRequestClient implements MergeRequestClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly group: string | null
  private readonly projects: string[]
  private readonly timeoutMs: number
  private readonly dispatcher: Dispatcher | undefined
  private readonly viaProxy: boolean
  private readonly fetchImpl: typeof undiciFetch
  private readonly diffEndpoint: 'auto' | 'diffs' | 'changes'
  /** Set once `/diffs` has proven unusable, so it is probed at most once per process. */
  private changesFallbackEngaged = false

  constructor(config: GitLabMergeRequestClientConfig) {
    if (!config.baseUrl) throw new Error('gitlab mr client: base_url is required')
    if (!config.token) throw new Error('gitlab mr client: token is required')

    const group = config.group?.trim() || null
    const projects = config.projects ?? []
    if (!group && projects.length === 0) {
      throw new Error('gitlab mr client: either group or a non-empty projects list is required')
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    this.group = group
    this.projects = projects
    this.timeoutMs = config.requestTimeoutMs ?? 30000

    const proxyUrl = config.proxyUrl !== undefined ? config.proxyUrl : proxyFromEnv()
    this.viaProxy = Boolean(proxyUrl)
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
    this.fetchImpl = config.fetchImpl ?? undiciFetch
    this.diffEndpoint = config.diffEndpoint ?? 'auto'

    getLogger().info(
      { viaProxy: this.viaProxy, baseUrl: this.baseUrl, mode: group ? 'group' : 'projects' },
      'gitlab_mr_client_ready',
    )
  }

  // --- MergeRequestClient ---------------------------------------------------

  async listOpenMergeRequests(opts: { updatedAfter: Date | null }): Promise<MergeRequestSummary[]> {
    const candidates = this.group
      ? await this.listGroupCandidates(opts.updatedAfter)
      : await this.listProjectCandidates(opts.updatedAfter)

    const seen = new Set<string>()
    const summaries: MergeRequestSummary[] = []
    for (const candidate of candidates) {
      const key = `${candidate.projectId}::${candidate.iid}`
      if (seen.has(key)) continue
      seen.add(key)
      // The list endpoints are not trusted to already carry diff_refs / draft
      // / source_project_id (design §7: "one detail call per candidate to
      // obtain sha, diff_refs, draft and the source-project id"). One extra
      // request per candidate MR is the accepted cost of never guessing at
      // whether those fields were present on the list response.
      const detail = await this.getMergeRequest(candidate.projectId, candidate.iid)
      if (detail) summaries.push(detail)
    }
    return summaries
  }

  async getMergeRequest(projectId: string, mrIid: number): Promise<MergeRequestSummary | null> {
    let raw: RawMergeRequest
    try {
      raw = await this.request<RawMergeRequest>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`,
      )
    } catch (err) {
      if (err instanceof GitLabApiError && err.status === 404) return null
      throw err
    }
    return mapMergeRequestSummary(raw, projectId)
  }

  /**
   * The changed files for one merge request.
   *
   * Two endpoints do this, and which one works depends on the instance:
   *
   *   /diffs    paginated, the modern one, and what GitLab's own docs point at.
   *   /changes  older and formally deprecated, but still served through 17.x.
   *
   * `/diffs` is tried first, but it is not reliable everywhere: on a real
   * GitLab 17.5.1 it answers 500 for a merge request that `/changes` returns
   * happily. So a 5xx (broken on this instance) or a 404 (endpoint absent on an
   * older one) falls back rather than failing the review — the two responses
   * carry the same per-file shape, so `mapDiffFile` handles both.
   *
   * The fallback is sticky for the life of the client: an instance that cannot
   * serve `/diffs` will not start being able to, and re-probing it once per
   * merge request would burn a failing request every time. One wasted request
   * per process, then never again.
   *
   * Deliberately narrow about what triggers it: a 401, 403 or 429 is a real
   * problem with the token or the rate limit, and silently trying another
   * endpoint would only bury it.
   */
  async listDiffs(projectId: string, mrIid: number): Promise<MergeRequestDiffFile[]> {
    const encoded = encodeURIComponent(projectId)

    if (this.diffEndpoint === 'diffs' || (this.diffEndpoint === 'auto' && !this.changesFallbackEngaged)) {
      try {
        const raw = await this.paginate<RawDiffFile>((page) =>
          `/projects/${encoded}/merge_requests/${mrIid}/diffs?per_page=${PER_PAGE}&page=${page}`,
        )
        return raw.map(mapDiffFile)
      } catch (err) {
        if (this.diffEndpoint === 'diffs' || !isDiffsEndpointUnusable(err)) throw err
        this.changesFallbackEngaged = true
        getLogger().warn(
          {
            projectId,
            mrIid,
            status: err instanceof GitLabApiError ? err.status : null,
          },
          'review_diffs_endpoint_unusable_using_changes',
        )
      }
    }

    return this.listChanges(encoded, projectId, mrIid)
  }

  /**
   * The `/changes` path, including one targeted retry.
   *
   * GitLab can serve a change list whose diff bodies are all empty when the
   * diffs have been offloaded to external storage; `access_raw_diffs=true`
   * makes it read them back. Empty diff bodies are indistinguishable from
   * GitLab's "too large to display" collapse, and the worker refuses to review
   * when everything is collapsed — so without this retry, an instance that
   * offloads diffs would have every review refused as "too large" with nothing
   * actually wrong. Only retried when EVERY file looks empty, because the
   * parameter makes GitLab do real work.
   */
  private async listChanges(
    encodedProject: string,
    projectId: string,
    mrIid: number,
  ): Promise<MergeRequestDiffFile[]> {
    const base = `/projects/${encodedProject}/merge_requests/${mrIid}/changes`
    const raw = await this.request<RawChangesResponse>('GET', base)
    let files = (raw.changes ?? []).map(mapDiffFile)

    if (raw.overflow) {
      // The change LIST itself was truncated, not just a file body: some files
      // are absent entirely. Worth saying out loud, because a reviewer that
      // cannot see a file will not mention it.
      getLogger().warn({ projectId, mrIid, files: files.length }, 'review_changes_response_overflowed')
    }

    const allEmpty = files.length > 0 && files.every((f) => f.diff === '' && !f.deletedFile)
    if (allEmpty) {
      const retried = await this.request<RawChangesResponse>('GET', `${base}?access_raw_diffs=true`)
      const retriedFiles = (retried.changes ?? []).map(mapDiffFile)
      if (retriedFiles.some((f) => f.diff !== '')) {
        getLogger().info({ projectId, mrIid }, 'review_changes_needed_raw_diffs')
        files = retriedFiles
      }
    }

    return files
  }

  async getFileAtRef(projectId: string, path: string, ref: string): Promise<string | null> {
    const apiPath =
      `/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}/raw` +
      `?ref=${encodeURIComponent(ref)}`
    const res = await this.doFetch('GET', apiPath)
    if (res.status === 404) return null
    if (!res.ok) throw new GitLabApiError(res.status, 'GET', apiPath)
    return await res.text()
  }

  async listNotes(projectId: string, mrIid: number): Promise<Array<{ id: string; body: string }>> {
    const raw = await this.paginate<RawNote>((page) =>
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes?per_page=${PER_PAGE}&page=${page}`,
    )
    return raw.map((note) => ({ id: String(note.id), body: note.body }))
  }

  async createNote(projectId: string, mrIid: number, body: string): Promise<string> {
    const raw = await this.request<RawNote>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
      { body },
    )
    return String(raw.id)
  }

  // --- discovery internals ---------------------------------------------------

  private async listGroupCandidates(
    updatedAfter: Date | null,
  ): Promise<Array<{ projectId: string; iid: number }>> {
    const group = this.group!
    const suffix = updatedAfter ? `&updated_after=${encodeURIComponent(updatedAfter.toISOString())}` : ''
    const raw = await this.paginate<RawMergeRequestListItem>((page) =>
      `/groups/${encodeURIComponent(group)}/merge_requests` +
      `?state=opened&order_by=updated_at&sort=desc${suffix}&per_page=${PER_PAGE}&page=${page}`,
    )
    return raw.map((item) => ({ projectId: projectPathFromListItem(item), iid: item.iid }))
  }

  private async listProjectCandidates(
    updatedAfter: Date | null,
  ): Promise<Array<{ projectId: string; iid: number }>> {
    const suffix = updatedAfter ? `&updated_after=${encodeURIComponent(updatedAfter.toISOString())}` : ''
    const out: Array<{ projectId: string; iid: number }> = []
    for (const projectId of this.projects) {
      const raw = await this.paginate<RawMergeRequestListItem>((page) =>
        `/projects/${encodeURIComponent(projectId)}/merge_requests` +
        `?state=opened&order_by=updated_at&sort=desc${suffix}&per_page=${PER_PAGE}&page=${page}`,
      )
      for (const item of raw) out.push({ projectId, iid: item.iid })
    }
    return out
  }

  // --- transport ---------------------------------------------------------------

  /** Paginates a GET endpoint, capped at 20 pages (SPEC-mirroring cap from tracker/gitlab.ts). */
  private async paginate<T>(pathForPage: (page: number) => string): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.request<T[]>('GET', pathForPage(page))
      if (!Array.isArray(batch) || batch.length === 0) break
      all.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return all
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(method, path, body)
    if (!res.ok) {
      // Never echo the response body: a GitLab error page can contain the
      // request that produced it, and the token travels in a header.
      throw new GitLabApiError(res.status, method, path)
    }
    return (await res.json()) as T
  }

  private async doFetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
    const url = `${this.baseUrl}/api/v4${path}`
    const init: RequestInit = {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Accept': 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      dispatcher: this.dispatcher,
    }
    if (body !== undefined) init.body = JSON.stringify(body)

    try {
      return (await this.fetchImpl(url, init)) as unknown as {
        ok: boolean
        status: number
        json: () => Promise<unknown>
        text: () => Promise<string>
      }
    } catch (err) {
      // fetch collapses every transport failure into "TypeError: fetch
      // failed" and hides the reason in `.cause`; unwrap it the same way
      // tracker/gitlab.ts does, for the same reason — nobody is watching a
      // terminal on an unattended reviewer run.
      throw new Error(
        `GitLab API ${method} ${path} could not connect: ${describeCause(err)} ` +
        `(egress: ${this.viaProxy ? 'via proxy' : 'DIRECT — no proxy configured'})`,
      )
    }
  }
}
