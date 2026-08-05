import { fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit } from 'undici'
import type { Issue, BlockerRef } from '../models.js'
import type { TrackerAdapter } from './base.js'
import { getLogger } from '../log.js'

/**
 * The proxy this process should reach the outside world through, or null.
 *
 * Node's global `fetch` is undici, and **undici does not read the proxy
 * environment variables**. Setting HTTP_PROXY in the container therefore does
 * nothing by itself: the request goes out direct, and in a deployment whose
 * networks are `internal: true` there is no route at all, so every call dies as
 * `TypeError: fetch failed` with the proxy sitting there unused. Reading the
 * variables here is what makes setting them mean something.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null
}

/**
 * GitLab Issues as the work tracker.
 *
 * A sibling of FileQueueTracker, not a replacement: the file queue needs no
 * network, no token and no server, which is what makes it the offline test path
 * and the zero-risk first run. This one is for real work.
 *
 * Two things shape the whole module.
 *
 * **State is labels, and we compute the whole set.** A GitLab issue only has
 * `opened`/`closed`, so workflow state lives in a `symphony::<state>` label. The
 * obvious implementation — add the new label, remove the old one — is two calls
 * and can leave an issue in both states if it dies between them. Instead every
 * transition sends the FULL label set on one `PUT`: existing labels minus every
 * `symphony::*`, plus the target. One request, no intermediate state, and no
 * dependence on scoped labels, which are a Premium feature. Scoped labels still
 * help — they render as key/value and are mutually exclusive in the UI — but
 * nothing here needs them.
 *
 * **There is no atomic claim.** The file queue gets one free: `rename(2)` either
 * moves the file or fails. The Issues API has no compare-and-swap, so two
 * orchestrators polling one project can both decide to dispatch the same issue.
 * With a single orchestrator the in-memory `claimed` set is the lock and this
 * cannot happen; with two, it can. That is a real limitation of this adapter and
 * it is documented rather than papered over — see docs/DESIGN.md §10.
 */

/** Issue fields this adapter reads. Everything else in the payload is ignored. */
interface GitLabIssue {
  iid: number
  title: string
  description?: string | null
  state?: string
  labels?: string[]
  web_url?: string
  created_at?: string
  updated_at?: string
}

interface GitLabIssueLink {
  iid: number
  link_type?: string
  state?: string
}

export interface GitLabTrackerConfig {
  /** Instance base URL, no trailing slash and no `/api/v4`. */
  baseUrl: string
  /** Numeric id or URL-encoded `group/project` path. */
  projectId: string
  /**
   * Read from the environment by the caller, never from the workflow file.
   * Keeping secrets out of config is a property worth preserving (DESIGN §8.3).
   */
  token: string
  /** Label namespace. `symphony` gives `symphony::todo`, `symphony::review`, … */
  labelPrefix?: string
  /** Workflow state -> label suffix. Defaults cover the six standard states. */
  stateLabels?: Record<string, string>
  /** States that also close the issue. Moving off one reopens it. */
  closedStates?: string[]
  requestTimeoutMs?: number
  /**
   * Proxy for GitLab traffic. Defaults to the environment; pass `null` to force
   * a direct connection.
   *
   * Scoped to this tracker rather than installed as undici's global dispatcher,
   * and that distinction is load-bearing: symphony also talks to the OpenCode
   * server at an internal hostname on a network the proxy cannot reach. A global
   * dispatcher would push those calls through the proxy too and break the one
   * connection symphony cannot do without. This is the same split NO_PROXY
   * expresses for tools that do read the environment.
   */
  proxyUrl?: string | null
  /** Injectable for tests. Defaults to undici's fetch, which honours `dispatcher`. */
  fetchImpl?: typeof undiciFetch
}

const DEFAULT_STATE_LABELS: Record<string, string> = {
  'Todo': 'todo',
  'In Progress': 'in-progress',
  'In Review': 'review',
  'Done': 'done',
  'Failed': 'failed',
  'Cancelled': 'cancelled',
}

/** An issue carrying none of our labels is not ours; it is skipped, not adopted. */
const UNTRACKED = null

/**
 * The useful part of a failed `fetch`: an errno, a TLS reason, anything but
 * "fetch failed". Walks the cause chain because undici nests them.
 */
export function describeCause(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 4; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown }
    const label = typeof e.code === 'string' ? e.code
      : typeof e.message === 'string' ? e.message
      : null
    if (label && !parts.includes(label)) parts.push(label)
    current = e.cause
  }
  return parts.length > 0 ? parts.join(': ') : String(err)
}

export class GitLabTracker implements TrackerAdapter {
  private readonly baseUrl: string
  private readonly projectId: string
  private readonly token: string
  private readonly labelPrefix: string
  private readonly stateLabels: Record<string, string>
  private readonly labelToState: Record<string, string>
  private readonly closedStates: Set<string>
  private readonly timeoutMs: number
  private readonly dispatcher: Dispatcher | undefined
  private readonly viaProxy: boolean
  private readonly fetchImpl: typeof undiciFetch

  constructor(config: GitLabTrackerConfig) {
    if (!config.baseUrl) throw new Error('gitlab tracker: base_url is required')
    if (!config.projectId) throw new Error('gitlab tracker: project_id is required')
    if (!config.token) throw new Error('gitlab tracker: token is required')

    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.projectId = encodeURIComponent(config.projectId)
    this.token = config.token
    this.labelPrefix = config.labelPrefix ?? 'symphony'
    this.stateLabels = { ...DEFAULT_STATE_LABELS, ...(config.stateLabels ?? {}) }
    this.closedStates = new Set(config.closedStates ?? ['Done', 'Cancelled'])
    this.timeoutMs = config.requestTimeoutMs ?? 30000

    this.labelToState = {}
    for (const [state, suffix] of Object.entries(this.stateLabels)) {
      this.labelToState[this.label(suffix).toLowerCase()] = state
    }

    const proxyUrl = config.proxyUrl !== undefined ? config.proxyUrl : proxyFromEnv()
    this.viaProxy = Boolean(proxyUrl)
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
    this.fetchImpl = config.fetchImpl ?? undiciFetch
    // Whether egress is proxied decides which failures are even possible, so it
    // belongs in the log before the first request rather than inferred from the
    // wreckage of one. The URL itself is not logged: it is allowed to carry
    // credentials.
    getLogger().info({ viaProxy: this.viaProxy, baseUrl: this.baseUrl }, 'gitlab_tracker_ready')
  }

  private label(suffix: string): string {
    return `${this.labelPrefix}::${suffix}`
  }

  private isStateLabel(label: string): boolean {
    return label.toLowerCase().startsWith(`${this.labelPrefix.toLowerCase()}::`)
  }

  // --- TrackerAdapter -------------------------------------------------------

  async fetchCandidateIssues(): Promise<Issue[]> {
    const raw = await this.listProjectIssues()
    const issues: Issue[] = []
    for (const node of raw) {
      const issue = this.normalize(node)
      if (issue) issues.push(issue)
    }
    // Blocker links cost one request each, so only resolve them where the
    // orchestrator will actually consult them — `shouldDispatch` checks
    // blockers for Todo and nothing else.
    await Promise.all(
      issues
        .filter((i) => i.state === 'Todo')
        .map(async (i) => { i.blockedBy = await this.fetchBlockers(Number(i.id)) }),
    )
    return issues
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const wanted = new Set(stateNames)
    const raw = await this.listProjectIssues()
    const out: Issue[] = []
    for (const node of raw) {
      const issue = this.normalize(node)
      if (issue && wanted.has(issue.state)) out.push(issue)
    }
    return out
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const results = await Promise.all(issueIds.map(async (id) => {
      try {
        const node = await this.request<GitLabIssue>('GET', `/issues/${encodeURIComponent(id)}`)
        return this.normalize(node)
      } catch (err) {
        // Same call as the file queue's: omitting an id reads to the
        // reconciler as "not visible", which leaves the run alone. Failing the
        // whole refresh because one issue 404'd would be worse.
        getLogger().warn({ issueId: id, error: String(err) }, 'gitlab_issue_refresh_failed')
        return null
      }
    }))
    return results.filter((i): i is Issue => i !== null)
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const suffix = this.stateLabels[stateName]
    if (!suffix) throw new Error(`gitlab tracker: no label configured for state "${stateName}"`)

    const current = await this.request<GitLabIssue>('GET', `/issues/${encodeURIComponent(issueId)}`)
    const currentState = this.stateOf(current)
    if (currentState === stateName) return   // idempotent, same as the file queue

    // The whole label set in one PUT. Anything not ours is preserved untouched:
    // a human's `bug` or `priority::1` label must survive a state change.
    const kept = (current.labels ?? []).filter((l) => !this.isStateLabel(l))
    const labels = [...kept, this.label(suffix)]

    const body: Record<string, string> = { labels: labels.join(',') }
    const shouldClose = this.closedStates.has(stateName)
    if (shouldClose && current.state !== 'closed') body.state_event = 'close'
    if (!shouldClose && current.state === 'closed') body.state_event = 'reopen'

    await this.request('PUT', `/issues/${encodeURIComponent(issueId)}`, body)
    getLogger().info({ issueId, from: currentState, to: stateName }, 'gitlab_state_updated')
  }

  // --- internals ------------------------------------------------------------

  /**
   * Every call re-reads the project, exactly as the file queue re-scans the
   * directory tree (DESIGN §7). A human relabelling an issue in the UI is a
   * supported operation, so there is nothing worth caching and nothing to
   * invalidate after a write.
   */
  private async listProjectIssues(): Promise<GitLabIssue[]> {
    const all: GitLabIssue[] = []
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<GitLabIssue[]>(
        'GET',
        `/issues?per_page=100&page=${page}&scope=all`,
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      all.push(...batch)
      if (batch.length < 100) break
    }
    return all
  }

  private async fetchBlockers(iid: number): Promise<BlockerRef[]> {
    try {
      const links = await this.request<GitLabIssueLink[]>('GET', `/issues/${iid}/links`)
      if (!Array.isArray(links)) return []
      // `blocks` / `is_blocked_by` are Premium; on Free this list only ever
      // holds `relates_to`, which is not a blocker. Degrades to "no blockers"
      // rather than erroring, which is the right shape either way.
      return links
        .filter((l) => l.link_type === 'is_blocked_by')
        .map((l) => ({
          id: String(l.iid),
          identifier: `issue-${l.iid}`,
          state: l.state === 'closed' ? 'Done' : 'In Progress',
        }))
    } catch (err) {
      getLogger().warn({ iid, error: String(err) }, 'gitlab_links_fetch_failed')
      return []
    }
  }

  /** Workflow state from labels, or UNTRACKED for an issue that is not ours. */
  private stateOf(node: GitLabIssue): string | typeof UNTRACKED {
    const found: string[] = []
    for (const label of node.labels ?? []) {
      const state = this.labelToState[label.toLowerCase()]
      if (state) found.push(state)
    }
    if (found.length === 0) return UNTRACKED
    if (found.length > 1) {
      // Only reachable if something bypassed updateIssueState — a hand edit, or
      // another tool. Refusing to guess is the safe direction: skip it and let a
      // human decide, exactly as a malformed queue file is skipped.
      getLogger().warn({ iid: node.iid, states: found }, 'gitlab_issue_has_multiple_state_labels')
      return UNTRACKED
    }
    return found[0]!
  }

  private normalize(node: GitLabIssue): Issue | null {
    const state = this.stateOf(node)
    if (state === UNTRACKED) return null

    const labels = (node.labels ?? []).map((l) => l.toLowerCase())
    return {
      id: String(node.iid),
      identifier: `issue-${node.iid}`,
      title: node.title,
      state,
      description: node.description ?? null,
      priority: readPriority(labels),
      branchName: null,
      url: node.web_url ?? null,
      labels,
      blockedBy: [],
      createdAt: node.created_at ? new Date(node.created_at) : null,
      updatedAt: node.updated_at ? new Date(node.updated_at) : null,
    }
  }

  private async request<T>(method: string, path: string, body?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}/api/v4/projects/${this.projectId}${path}`
    const init: RequestInit = {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      dispatcher: this.dispatcher,
    }
    if (body) init.body = JSON.stringify(body)

    let res
    try {
      res = await this.fetchImpl(url, init)
    } catch (err) {
      // fetch collapses every transport failure into "TypeError: fetch failed"
      // and hides the reason in `.cause`. Unwrapping it is the difference
      // between "something is wrong" and "ECONNREFUSED to the proxy" — and this
      // is the layer where nobody is watching a terminal to go and find out.
      throw new Error(
        `GitLab API ${method} ${path} could not connect: ${describeCause(err)} ` +
        `(egress: ${this.viaProxy ? 'via proxy' : 'DIRECT — no proxy configured'})`,
      )
    }
    if (!res.ok) {
      // Never echo the response body: a GitLab error page can contain the
      // request that produced it, and the token travels in a header.
      throw new Error(`GitLab API ${method} ${path} returned ${res.status}`)
    }
    return (await res.json()) as T
  }
}

/**
 * Priority from a `priority::N` label. GitLab has no numeric priority on Free
 * (weight is Premium), and `dispatchKey` treats a null priority as last, so an
 * unlabelled issue simply sorts after labelled ones.
 */
export function readPriority(labels: string[]): number | null {
  for (const label of labels) {
    const m = /^priority::(\d+)$/.exec(label)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n >= 0) return n
    }
  }
  return null
}
