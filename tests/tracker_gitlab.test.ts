import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GitLabTracker, readPriority, proxyFromEnv, describeCause } from '../src/tracker/gitlab.js'
import { SymphonyOrchestrator } from '../src/orchestrator.js'

const BASE = 'https://gitlab.internal.example'
const PROJECT = 'group/project'
const API = `${BASE}/api/v4/projects/${encodeURIComponent(PROJECT)}`

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

let calls: Call[]
let routes: Array<{ match: (m: string, u: string) => boolean; status?: number; json: unknown }>

/**
 * A fake `fetch` over a route table rather than a mocked GitLabTracker: the
 * thing worth testing is the request this adapter actually builds — one PUT
 * carrying a full label set — and a mocked client would assert nothing about
 * that.
 */
function route(method: string, urlPart: string, json: unknown, status = 200) {
  routes.unshift({
    match: (m, u) => m === method && u.includes(urlPart),
    status,
    json,
  })
}

let fakeFetch: (url: string, init: RequestInit) => Promise<unknown>

beforeEach(() => {
  calls = []
  routes = []
  fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const hit = routes.find((r) => r.match(method, String(url)))
    if (!hit) return { ok: false, status: 404, json: async () => ({}) }
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      json: async () => hit.json,
    }
  })
})

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Injected rather than stubbed onto globalThis: the adapter calls undici's
 * fetch, not the global one, because only undici's honours the `dispatcher`
 * that routes it through a proxy. `proxyUrl: null` keeps the suite hermetic —
 * without it, a machine that happens to export HTTPS_PROXY would have these
 * tests building a real ProxyAgent.
 */
function tracker(overrides?: Partial<ConstructorParameters<typeof GitLabTracker>[0]>) {
  return new GitLabTracker({
    baseUrl: BASE, projectId: PROJECT, token: 'glpat-secret',
    proxyUrl: null, fetchImpl: fakeFetch as never, ...overrides,
  })
}

function issue(iid: number, labels: string[], extra: Record<string, unknown> = {}) {
  return {
    iid, title: `Issue ${iid}`, description: 'do the thing', state: 'opened',
    labels, web_url: `${BASE}/${PROJECT}/-/issues/${iid}`,
    created_at: '2026-08-04T09:00:00Z', updated_at: '2026-08-04T09:00:00Z',
    ...extra,
  }
}

describe('construction', () => {
  it('rejects a missing token, project or base url', () => {
    expect(() => tracker({ token: '' })).toThrow(/token/)
    expect(() => tracker({ projectId: '' })).toThrow(/project_id/)
    expect(() => tracker({ baseUrl: '' })).toThrow(/base_url/)
  })

  it('url-encodes a path-style project id', async () => {
    route('GET', '/issues?', [])
    await tracker().fetchCandidateIssues()
    expect(calls[0]!.url).toContain('projects/group%2Fproject')
  })

  it('sends the token as PRIVATE-TOKEN and never in the URL', async () => {
    route('GET', '/issues?', [])
    await tracker().fetchCandidateIssues()
    expect(calls[0]!.headers['PRIVATE-TOKEN']).toBe('glpat-secret')
    expect(calls[0]!.url).not.toContain('glpat-secret')
  })
})

describe('state from labels', () => {
  it('maps the symphony:: label to a workflow state', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo']), issue(2, ['symphony::review'])])
    const found = await tracker().fetchIssuesByStates(['Todo', 'In Review'])
    expect(found.map((i) => [i.identifier, i.state])).toEqual([
      ['issue-1', 'Todo'], ['issue-2', 'In Review'],
    ])
  })

  it('ignores issues carrying no symphony label', async () => {
    route('GET', '/issues?', [issue(1, ['bug']), issue(2, ['symphony::todo'])])
    const found = await tracker().fetchCandidateIssues()
    expect(found.map((i) => i.id)).toEqual(['2'])
  })

  it('skips an issue carrying two state labels rather than guessing', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo', 'symphony::review'])])
    const found = await tracker().fetchCandidateIssues()
    expect(found).toEqual([])
  })

  it('honours a custom label prefix', async () => {
    route('GET', '/issues?', [issue(1, ['bot::todo'])])
    const found = await tracker({ labelPrefix: 'bot' }).fetchCandidateIssues()
    expect(found[0]!.state).toBe('Todo')
  })
})

describe('updateIssueState', () => {
  it('sends the whole label set in one PUT, preserving non-symphony labels', async () => {
    route('GET', '/issues/1', issue(1, ['bug', 'priority::2', 'symphony::todo']))
    route('PUT', '/issues/1', issue(1, ['bug', 'priority::2', 'symphony::in-progress']))

    await tracker().updateIssueState('1', 'In Progress')

    const put = calls.find((c) => c.method === 'PUT')!
    expect(put).toBeDefined()
    const labels = String((put.body as Record<string, string>).labels).split(',')
    // the old state label is gone, the new one is present...
    expect(labels).toContain('symphony::in-progress')
    expect(labels).not.toContain('symphony::todo')
    // ...and a human's labels survived the transition untouched.
    expect(labels).toContain('bug')
    expect(labels).toContain('priority::2')
  })

  it('is one request, not an add followed by a remove', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::todo']))
    route('PUT', '/issues/1', issue(1, ['symphony::in-progress']))
    await tracker().updateIssueState('1', 'In Progress')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('is idempotent when the issue is already in the target state', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::review']))
    await tracker().updateIssueState('1', 'In Review')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('closes the issue on a terminal state', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::review']))
    route('PUT', '/issues/1', issue(1, ['symphony::done'], { state: 'closed' }))
    await tracker().updateIssueState('1', 'Done')
    expect((calls.find((c) => c.method === 'PUT')!.body as Record<string, string>).state_event).toBe('close')
  })

  it('reopens a closed issue when moving back to an active state', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::done'], { state: 'closed' }))
    route('PUT', '/issues/1', issue(1, ['symphony::todo']))
    await tracker().updateIssueState('1', 'Todo')
    expect((calls.find((c) => c.method === 'PUT')!.body as Record<string, string>).state_event).toBe('reopen')
  })

  it('does not send state_event when the open/closed state is already right', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::todo']))
    route('PUT', '/issues/1', issue(1, ['symphony::in-progress']))
    await tracker().updateIssueState('1', 'In Progress')
    expect((calls.find((c) => c.method === 'PUT')!.body as Record<string, string>).state_event).toBeUndefined()
  })

  it('rejects a state with no configured label', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::todo']))
    await expect(tracker().updateIssueState('1', 'Nonsense')).rejects.toThrow(/no label configured/)
  })
})

describe('blockers', () => {
  it('treats only is_blocked_by links as blockers', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    route('GET', '/issues/1/links', [
      { iid: 5, link_type: 'relates_to', state: 'opened' },
      { iid: 6, link_type: 'is_blocked_by', state: 'opened' },
    ])
    const [found] = await tracker().fetchCandidateIssues()
    expect(found!.blockedBy.map((b) => b.id)).toEqual(['6'])
  })

  it('resolves links only for Todo issues, since nothing else consults them', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::in-progress']), issue(2, ['symphony::review'])])
    await tracker().fetchCandidateIssues()
    expect(calls.filter((c) => c.url.includes('/links'))).toHaveLength(0)
  })

  it('degrades to no blockers when the links endpoint fails (Free tier)', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    route('GET', '/issues/1/links', {}, 403)
    const [found] = await tracker().fetchCandidateIssues()
    expect(found!.blockedBy).toEqual([])
  })
})

describe('fetchIssueStatesByIds', () => {
  it('omits an issue that cannot be read rather than failing the batch', async () => {
    route('GET', '/issues/1', issue(1, ['symphony::in-progress']))
    route('GET', '/issues/2', {}, 404)
    const found = await tracker().fetchIssueStatesByIds(['1', '2'])
    expect(found.map((i) => i.id)).toEqual(['1'])
  })
})

describe('normalization', () => {
  it('reads priority from a priority::N label and lowercases labels', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo', 'Priority::3', 'Bug'])])
    const [found] = await tracker().fetchCandidateIssues()
    expect(found!.priority).toBe(3)
    expect(found!.labels).toContain('bug')
  })

  it('leaves priority null when no priority label is present', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    const [found] = await tracker().fetchCandidateIssues()
    expect(found!.priority).toBeNull()
  })

  it('exposes the web url, unlike the file queue', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    const [found] = await tracker().fetchCandidateIssues()
    expect(found!.url).toBe(`${BASE}/${PROJECT}/-/issues/1`)
  })
})

describe('readPriority', () => {
  it('parses, ignores junk, and takes the first match', () => {
    expect(readPriority(['priority::1'])).toBe(1)
    expect(readPriority(['priority::x', 'priority::2'])).toBe(2)
    expect(readPriority(['bug'])).toBeNull()
    expect(readPriority(['priority::-1'])).toBeNull()
  })
})

describe('errors', () => {
  it('never puts the response body in the error, so a token cannot leak', async () => {
    route('GET', '/issues?', { message: 'PRIVATE-TOKEN glpat-secret rejected' }, 401)
    await expect(tracker().fetchCandidateIssues()).rejects.toThrow(/returned 401/)
    await expect(tracker().fetchCandidateIssues()).rejects.not.toThrow(/glpat-secret/)
  })

  it('reports the real transport cause, not "fetch failed"', async () => {
    // What "TypeError: fetch failed" cost us: a first live run that said only
    // that something was wrong, with the reason buried in err.cause. Nobody is
    // at a terminal to go digging on an unattended run.
    const boom = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3128'), { code: 'ECONNREFUSED' }),
    })
    const t = tracker({ fetchImpl: (async () => { throw boom }) as never })
    await expect(t.fetchCandidateIssues()).rejects.toThrow(/ECONNREFUSED/)
  })

  it('says which way egress was attempted when a connection fails', async () => {
    // Direct-vs-proxied is the single most useful bit for this failure, and it
    // is not otherwise recoverable from the logs.
    const boom = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('nope'), { code: 'ENOTFOUND' }),
    })
    const direct = tracker({ proxyUrl: null, fetchImpl: (async () => { throw boom }) as never })
    await expect(direct.fetchCandidateIssues()).rejects.toThrow(/DIRECT — no proxy configured/)

    const proxied = tracker({ proxyUrl: 'http://squid:3128', fetchImpl: (async () => { throw boom }) as never })
    await expect(proxied.fetchCandidateIssues()).rejects.toThrow(/via proxy/)
  })

  it('does not leak the proxy URL, which may carry credentials', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const t = tracker({
      proxyUrl: 'http://user:hunter2@squid:3128',
      fetchImpl: (async () => { throw boom }) as never,
    })
    await expect(t.fetchCandidateIssues()).rejects.not.toThrow(/hunter2/)
  })
})

describe('proxy configuration', () => {
  // Node's global fetch is undici and undici ignores HTTP_PROXY, so setting the
  // variable did nothing until this read it. On a stack whose networks are all
  // `internal: true` that is the difference between working and every single
  // API call failing.
  it('takes the proxy from the environment, preferring HTTPS_PROXY', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:3128', HTTP_PROXY: 'http://b:3128' })).toBe('http://a:3128')
    expect(proxyFromEnv({ HTTP_PROXY: 'http://b:3128' })).toBe('http://b:3128')
    expect(proxyFromEnv({ http_proxy: 'http://c:3128' })).toBe('http://c:3128')
    expect(proxyFromEnv({})).toBeNull()
  })

  it('sends a dispatcher with every request when a proxy is configured', async () => {
    const seen: Array<unknown> = []
    const t = tracker({
      proxyUrl: 'http://squid:3128',
      fetchImpl: (async (_u: string, init: { dispatcher?: unknown }) => {
        seen.push(init.dispatcher)
        return { ok: true, status: 200, json: async () => [] }
      }) as never,
    })
    await t.fetchCandidateIssues()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeDefined()
  })

  it('sends no dispatcher when no proxy is configured', async () => {
    const seen: Array<unknown> = []
    const t = tracker({
      proxyUrl: null,
      fetchImpl: (async (_u: string, init: { dispatcher?: unknown }) => {
        seen.push(init.dispatcher)
        return { ok: true, status: 200, json: async () => [] }
      }) as never,
    })
    await t.fetchCandidateIssues()
    expect(seen[0]).toBeUndefined()
  })
})

describe('describeCause', () => {
  it('walks the cause chain and keeps the first useful label', () => {
    expect(describeCause(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    }))).toContain('ECONNREFUSED')
  })
  it('falls back to the message when there is no code', () => {
    expect(describeCause(new Error('self-signed certificate in chain')))
      .toContain('self-signed certificate')
  })
  it('does not loop forever on a self-referencing cause', () => {
    const e: { message: string; cause?: unknown } = { message: 'a' }
    e.cause = e
    expect(describeCause(e)).toBe('a')
  })
})

describe('full tick loop against GitLabTracker', () => {
  it('dispatches a Todo issue and records In Review on a clean exit', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    route('GET', '/issues/1/links', [])
    route('GET', '/issues/1', issue(1, ['symphony::todo']))
    route('PUT', '/issues/1', issue(1, ['symphony::in-progress']))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: 's', success: true, turnsCompleted: 1 })) }
    const orch = new SymphonyOrchestrator({
      tracker: tracker(), agentRunner: agentRunner as any,
      promptTemplate: 'Work {{ issue.identifier }}', terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    expect(agentRunner.run).toHaveBeenCalledTimes(1)
    const puts = calls.filter((c) => c.method === 'PUT')
      .map((c) => String((c.body as Record<string, string>).labels))
    // claim, then the exit transition — the run must not end in in-progress.
    expect(puts[0]).toContain('symphony::in-progress')
    expect(puts[1]).toContain('symphony::review')
  })

  it('records Failed on an abnormal exit', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::todo'])])
    route('GET', '/issues/1/links', [])
    route('GET', '/issues/1', issue(1, ['symphony::todo']))
    route('PUT', '/issues/1', issue(1, ['symphony::failed']))

    const agentRunner = { run: vi.fn(async () => ({ sessionId: null, success: false, turnsCompleted: 0 })) }
    const orch = new SymphonyOrchestrator({
      tracker: tracker(), agentRunner: agentRunner as any,
      promptTemplate: '', terminalStates: ['Done', 'Cancelled'],
    })

    await (orch as any).tick()
    await Promise.all(Array.from(orch.state.running.values()).map((e) => e.task))

    const puts = calls.filter((c) => c.method === 'PUT')
      .map((c) => String((c.body as Record<string, string>).labels))
    expect(puts[puts.length - 1]).toContain('symphony::failed')
  })

  it('never dispatches an issue parked in review — the human gate holds', async () => {
    route('GET', '/issues?', [issue(1, ['symphony::review'])])
    const agentRunner = { run: vi.fn() }
    const orch = new SymphonyOrchestrator({
      tracker: tracker(), agentRunner: agentRunner as any,
      promptTemplate: '', terminalStates: ['Done', 'Cancelled'],
    })
    await (orch as any).tick()
    expect(agentRunner.run).not.toHaveBeenCalled()
  })
})
