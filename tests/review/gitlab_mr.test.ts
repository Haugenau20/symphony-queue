import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  GitLabMergeRequestClient,
  GitLabApiError,
  mapMergeRequestSummary,
  mapDiffFile,
  projectPathFromListItem,
} from '../../src/review/gitlab_mr.js'

const BASE = 'https://gitlab.internal.example'

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

let calls: Call[]
let routes: Array<{ match: (m: string, u: string) => boolean; status?: number; json?: unknown; text?: string }>

function route(method: string, urlPart: string, json: unknown, status = 200) {
  routes.unshift({ match: (m, u) => m === method && u.includes(urlPart), status, json })
}

function routeText(method: string, urlPart: string, text: string, status = 200) {
  routes.unshift({ match: (m, u) => m === method && u.includes(urlPart), status, text })
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
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      json: async () => hit.json,
      text: async () => hit.text ?? '',
    }
  })
})

afterEach(() => { vi.unstubAllGlobals() })

function client(overrides?: Partial<ConstructorParameters<typeof GitLabMergeRequestClient>[0]>) {
  return new GitLabMergeRequestClient({
    baseUrl: BASE, token: 'glpat-review-secret', group: 'my-group',
    proxyUrl: null, fetchImpl: fakeFetch as never, ...overrides,
  })
}

function mr(iid: number, extra: Record<string, unknown> = {}) {
  return {
    iid,
    title: `MR ${iid}`,
    description: 'do the thing',
    draft: false,
    source_project_id: 100,
    target_project_id: 100,
    state: 'opened',
    web_url: `${BASE}/my-group/my-project/-/merge_requests/${iid}`,
    updated_at: '2026-08-10T09:00:00Z',
    diff_refs: { base_sha: 'base123', start_sha: 'start123', head_sha: 'head123' },
    ...extra,
  }
}

// ---------------------------------------------------------------------------

describe('construction', () => {
  it('rejects a missing token or base url', () => {
    expect(() => client({ token: '' })).toThrow(/token/)
    expect(() => client({ baseUrl: '' })).toThrow(/base_url/)
  })

  it('rejects when neither a group nor a project list is given', () => {
    expect(() => client({ group: undefined, projects: undefined })).toThrow(/group|project/)
    expect(() => client({ group: undefined, projects: [] })).toThrow(/group|project/)
  })

  it('accepts a project list with no group', () => {
    expect(() => client({ group: undefined, projects: ['g/p'] })).not.toThrow()
  })
})

describe('getMergeRequest', () => {
  it('maps a ready MR (diff_refs present) to a full summary', async () => {
    route('GET', '/merge_requests/5', mr(5))
    const found = await client().getMergeRequest('g/p', 5)
    expect(found).toEqual({
      projectId: 'g/p',
      mrIid: 5,
      headSha: 'head123',
      baseSha: 'base123',
      startSha: 'start123',
      title: 'MR 5',
      description: 'do the thing',
      draft: false,
      isFork: false,
      state: 'opened',
      webUrl: `${BASE}/my-group/my-project/-/merge_requests/5`,
      updatedAt: new Date('2026-08-10T09:00:00Z'),
    })
  })

  it('returns null on a 404 rather than throwing', async () => {
    route('GET', '/merge_requests/9', { message: 'not found' }, 404)
    const found = await client().getMergeRequest('g/p', 9)
    expect(found).toBeNull()
  })

  it('url-encodes the project id and sends the token as PRIVATE-TOKEN, never in the URL', async () => {
    route('GET', '/merge_requests/5', mr(5))
    await client().getMergeRequest('g/p', 5)
    expect(calls[0]!.url).toContain('projects/g%2Fp')
    expect(calls[0]!.headers['PRIVATE-TOKEN']).toBe('glpat-review-secret')
    expect(calls[0]!.url).not.toContain('glpat-review-secret')
  })
})

describe('draft detection — the boolean field, never the wip query filter', () => {
  it('is caught for a MR titled "Draft: ..." with draft:true', async () => {
    route('GET', '/merge_requests/1', mr(1, { title: 'Draft: add feature', draft: true }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found!.draft).toBe(true)
  })

  it('is caught for a MR titled "WIP: ..." with draft:true', async () => {
    route('GET', '/merge_requests/2', mr(2, { title: 'WIP: add feature', draft: true }))
    const found = await client().getMergeRequest('g/p', 2)
    expect(found!.draft).toBe(true)
  })

  it('never sends the wip query parameter on a listing request', async () => {
    route('GET', '/groups/my-group/merge_requests', [])
    await client().listOpenMergeRequests({ updatedAfter: null })
    for (const call of calls) expect(call.url).not.toMatch(/[?&]wip=/)
  })

  it('a non-draft, non-WIP-titled MR reports draft:false', async () => {
    route('GET', '/merge_requests/3', mr(3, { title: 'Ordinary change', draft: false }))
    const found = await client().getMergeRequest('g/p', 3)
    expect(found!.draft).toBe(false)
  })
})

describe('fork detection', () => {
  it('flags isFork when source and target project ids differ', async () => {
    route('GET', '/merge_requests/1', mr(1, { source_project_id: 200, target_project_id: 100 }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found!.isFork).toBe(true)
  })

  it('does not flag isFork when source and target project ids match', async () => {
    route('GET', '/merge_requests/1', mr(1, { source_project_id: 100, target_project_id: 100 }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found!.isFork).toBe(false)
  })
})

describe('diff_refs absent — not-ready MRs', () => {
  it('returns headSha \'\' rather than throwing when diff_refs is missing', async () => {
    route('GET', '/merge_requests/1', mr(1, { diff_refs: undefined }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found).not.toBeNull()
    expect(found!.headSha).toBe('')
    expect(found!.baseSha).toBe('')
    expect(found!.startSha).toBe('')
  })

  it('returns headSha \'\' when diff_refs is present but null', async () => {
    route('GET', '/merge_requests/1', mr(1, { diff_refs: null }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found!.headSha).toBe('')
  })

  it('treats an empty head_sha string inside diff_refs the same as absent', async () => {
    route('GET', '/merge_requests/1', mr(1, { diff_refs: { base_sha: 'b', start_sha: 's', head_sha: '' } }))
    const found = await client().getMergeRequest('g/p', 1)
    expect(found!.headSha).toBe('')
  })

  it('does not throw when listOpenMergeRequests encounters a not-ready candidate', async () => {
    route('GET', '/groups/my-group/merge_requests', [{ iid: 1, project_id: 100, references: { full: 'g/p!1' } }])
    route('GET', '/merge_requests/1', mr(1, { diff_refs: undefined }))
    const found = await client().listOpenMergeRequests({ updatedAfter: null })
    expect(found).toHaveLength(1)
    expect(found[0]!.headSha).toBe('')
  })
})

describe('listOpenMergeRequests — group mode', () => {
  it('paginates the group listing, capped at 20 pages', async () => {
    // A dedicated fetch (rather than the substring-matching route table) so
    // 2000 distinct iids can't collide with each other by prefix.
    let listCallCount = 0
    const customFetch = (async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url: String(url), body: null, headers: (init?.headers ?? {}) as Record<string, string> })
      const u = String(url)
      if (u.includes('/groups/my-group/merge_requests')) {
        listCallCount++
        // Careful: "per_page=100" itself contains the substring "page=100",
        // so an unanchored /page=(\d+)/ would match there first. Anchor on
        // the query-parameter boundary instead.
        const page = Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? '1')
        if (page > 21) return { ok: true, status: 200, json: async () => [], text: async () => '' }
        const items = Array.from({ length: 100 }, (_, i) => {
          const iid = (page - 1) * 100 + i + 1
          return { iid, project_id: 100, references: { full: `g/p!${iid}` } }
        })
        return { ok: true, status: 200, json: async () => items, text: async () => '' }
      }
      const detailMatch = /\/merge_requests\/(\d+)$/.exec(u)
      if (detailMatch) {
        const iid = Number(detailMatch[1])
        return { ok: true, status: 200, json: async () => mr(iid), text: async () => '' }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    }) as never

    const found = await client({ fetchImpl: customFetch }).listOpenMergeRequests({ updatedAfter: null })
    // 20 pages * 100 items/page = 2000 candidates hydrated; page 21 (which
    // would prove the cap wrong if fetched) never gets called.
    expect(found).toHaveLength(2000)
    expect(listCallCount).toBe(20)
  }, 20000)

  it('sends updated_after as ISO 8601 when provided', async () => {
    route('GET', '/groups/my-group/merge_requests', [])
    const cursor = new Date('2026-08-01T00:00:00.000Z')
    await client().listOpenMergeRequests({ updatedAfter: cursor })
    const listCall = calls.find((c) => c.url.includes('/groups/'))!
    expect(listCall.url).toContain(`updated_after=${encodeURIComponent(cursor.toISOString())}`)
  })

  it('omits updated_after when the cursor is null', async () => {
    route('GET', '/groups/my-group/merge_requests', [])
    await client().listOpenMergeRequests({ updatedAfter: null })
    const listCall = calls.find((c) => c.url.includes('/groups/'))!
    expect(listCall.url).not.toContain('updated_after')
  })

  it('dedupes a candidate that appears twice across pages', async () => {
    route('GET', '/groups/my-group/merge_requests', [
      { iid: 1, project_id: 100, references: { full: 'g/p!1' } },
      { iid: 1, project_id: 100, references: { full: 'g/p!1' } },
    ])
    route('GET', '/merge_requests/1', mr(1))
    await client().listOpenMergeRequests({ updatedAfter: null })
    const detailCalls = calls.filter((c) => c.url.includes('/merge_requests/1') && !c.url.includes('/groups/'))
    expect(detailCalls).toHaveLength(1)
  })
})

describe('listOpenMergeRequests — falls back to per-project listing', () => {
  it('calls the per-project endpoint for each configured project when no group is set', async () => {
    route('GET', '/projects/g%2Fp1/merge_requests', [{ iid: 1, project_id: 1 }])
    route('GET', '/projects/g%2Fp2/merge_requests', [{ iid: 2, project_id: 2 }])
    route('GET', '/merge_requests/1', mr(1))
    route('GET', '/merge_requests/2', mr(2))

    const found = await client({ group: undefined, projects: ['g/p1', 'g/p2'] }).listOpenMergeRequests({ updatedAfter: null })
    expect(found.map((f) => f.mrIid).sort()).toEqual([1, 2])
    expect(calls.some((c) => c.url.includes('/groups/'))).toBe(false)
  })
})

describe('listDiffs', () => {
  it('maps diff file fields, including collapsed detection', async () => {
    route('GET', '/merge_requests/5/diffs', [
      { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1,1 +1,1 @@\n-x\n+y\n', new_file: false, renamed_file: false, deleted_file: false },
      { old_path: 'big.ts', new_path: 'big.ts', diff: '', new_file: false, renamed_file: false, deleted_file: false },
      { old_path: 'gone.ts', new_path: 'gone.ts', diff: '', new_file: false, renamed_file: false, deleted_file: true },
    ])
    const files = await client().listDiffs('g/p', 5)
    expect(files).toHaveLength(3)
    expect(files[0]).toMatchObject({ oldPath: 'a.ts', collapsed: false })
    expect(files[1]).toMatchObject({ oldPath: 'big.ts', collapsed: true }) // empty + not deleted = collapsed
    expect(files[2]).toMatchObject({ oldPath: 'gone.ts', collapsed: false }) // empty + deleted = genuinely empty
  })

  it('paginates the diffs endpoint', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ old_path: `f${i}.ts`, new_path: `f${i}.ts`, diff: '' }))
    const page2 = [{ old_path: 'last.ts', new_path: 'last.ts', diff: '' }]
    route('GET', '/merge_requests/5/diffs?per_page=100&page=1', page1)
    route('GET', '/merge_requests/5/diffs?per_page=100&page=2', page2)
    const files = await client().listDiffs('g/p', 5)
    expect(files).toHaveLength(101)
  })

  it('defaults generatedFile to false when the field is absent (older GitLab)', async () => {
    route('GET', '/merge_requests/5/diffs', [{ old_path: 'a.ts', new_path: 'a.ts', diff: '' }])
    const files = await client().listDiffs('g/p', 5)
    expect(files[0]!.generatedFile).toBe(false)
  })
})

describe('getFileAtRef', () => {
  it('fetches the raw blob and returns it as text', async () => {
    routeText('GET', '/repository/files/', 'file contents here')
    const content = await client().getFileAtRef('g/p', 'src/index.ts', 'abc123')
    expect(content).toBe('file contents here')
    expect(calls[0]!.url).toContain('/repository/files/src%2Findex.ts/raw')
    expect(calls[0]!.url).toContain('ref=abc123')
  })

  it('returns null on a 404 (file does not exist at that ref)', async () => {
    routeText('GET', '/repository/files/', '', 404)
    const content = await client().getFileAtRef('g/p', 'missing.ts', 'abc123')
    expect(content).toBeNull()
  })

  it('throws on a non-404 error without including the response body', async () => {
    routeText('GET', '/repository/files/', 'internal server details', 500)
    await expect(client().getFileAtRef('g/p', 'x.ts', 'abc123')).rejects.toThrow(/returned 500/)
    await expect(client().getFileAtRef('g/p', 'x.ts', 'abc123')).rejects.not.toThrow(/internal server details/)
  })
})

describe('listNotes / createNote', () => {
  it('lists notes with string ids', async () => {
    route('GET', '/merge_requests/5/notes', [{ id: 10, body: 'first' }, { id: 11, body: 'second' }])
    const notes = await client().listNotes('g/p', 5)
    // An instance that reports no author yields null, never a guess — the
    // publisher treats null as "not ours" rather than assuming it is.
    expect(notes).toEqual([
      { id: '10', body: 'first', authorId: null },
      { id: '11', body: 'second', authorId: null },
    ])
  })

  it('maps the note author, which is what makes the publish marker trustworthy', async () => {
    route('GET', '/merge_requests/5/notes', [
      { id: 10, body: 'ours', author: { id: 7 } },
      { id: 11, body: 'theirs', author: { id: 99 } },
    ])
    const notes = await client().listNotes('g/p', 5)
    expect(notes.map((n) => n.authorId)).toEqual(['7', '99'])
  })

  it('getCurrentUserId resolves the token holder, and caches it', async () => {
    route('GET', '/user', { id: 7 })
    const c = client()
    expect(await c.getCurrentUserId()).toBe('7')
    expect(await c.getCurrentUserId()).toBe('7')
    expect(calls.filter((x) => x.url.includes('/user')).length).toBe(1)
  })

  it('getCurrentUserId degrades to null rather than throwing, and does not retry every call', async () => {
    // A publish must not fail because identity could not be established; the
    // publisher falls back to marker-only dedup, which is the check that
    // actually prevents double-posting.
    route('GET', '/user', null, 500)
    const c = client()
    expect(await c.getCurrentUserId()).toBeNull()
    expect(await c.getCurrentUserId()).toBeNull()
    expect(calls.filter((x) => x.url.includes('/user')).length).toBe(1)
  })

  it('creates a note and returns its id as a string', async () => {
    route('POST', '/merge_requests/5/notes', { id: 42 })
    const id = await client().createNote('g/p', 5, 'a review comment')
    expect(id).toBe('42')
    const call = calls.find((c) => c.method === 'POST')!
    expect(call.body).toEqual({ body: 'a review comment' })
  })
})

describe('errors', () => {
  it('never puts the response body in the error, so a token cannot leak', async () => {
    route('GET', '/merge_requests/5', { message: 'PRIVATE-TOKEN glpat-review-secret rejected' }, 401)
    await expect(client().getMergeRequest('g/p', 5)).rejects.toThrow(/returned 401/)
    await expect(client().getMergeRequest('g/p', 5)).rejects.not.toThrow(/glpat-review-secret/)
  })

  it('reports the real transport cause via describeCause, not "fetch failed"', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3128'), { code: 'ECONNREFUSED' }),
    })
    const c = client({ fetchImpl: (async () => { throw boom }) as never })
    await expect(c.getMergeRequest('g/p', 1)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('says which way egress was attempted', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const direct = client({ proxyUrl: null, fetchImpl: (async () => { throw boom }) as never })
    await expect(direct.getMergeRequest('g/p', 1)).rejects.toThrow(/DIRECT — no proxy configured/)
    const proxied = client({ proxyUrl: 'http://squid:3128', fetchImpl: (async () => { throw boom }) as never })
    await expect(proxied.getMergeRequest('g/p', 1)).rejects.toThrow(/via proxy/)
  })

  it('GitLabApiError carries the status without a body', () => {
    const err = new GitLabApiError(403, 'GET', '/projects/x/merge_requests/1')
    expect(err.status).toBe(403)
    expect(err.message).toBe('GitLab API GET /projects/x/merge_requests/1 returned 403')
  })
})

describe('proxy configuration', () => {
  it('sends a scoped dispatcher, never a global one', async () => {
    const seen: Array<unknown> = []
    const c = client({
      proxyUrl: 'http://squid:3128',
      fetchImpl: (async (_u: string, init: { dispatcher?: unknown }) => {
        seen.push(init.dispatcher)
        return { ok: true, status: 200, json: async () => [], text: async () => '' }
      }) as never,
    })
    await c.listOpenMergeRequests({ updatedAfter: null })
    expect(seen[0]).toBeDefined()
  })

  it('sends no dispatcher when no proxy is configured', async () => {
    const seen: Array<unknown> = []
    const c = client({
      proxyUrl: null,
      fetchImpl: (async (_u: string, init: { dispatcher?: unknown }) => {
        seen.push(init.dispatcher)
        return { ok: true, status: 200, json: async () => [], text: async () => '' }
      }) as never,
    })
    await c.listOpenMergeRequests({ updatedAfter: null })
    expect(seen[0]).toBeUndefined()
  })
})

describe('pure mapping helpers', () => {
  it('projectPathFromListItem derives the path from references.full', () => {
    expect(projectPathFromListItem({ iid: 1, references: { full: 'group/sub/project!123' } })).toBe('group/sub/project')
  })

  it('projectPathFromListItem falls back to the numeric project_id when references.full is absent', () => {
    expect(projectPathFromListItem({ iid: 1, project_id: 77 })).toBe('77')
  })

  it('mapMergeRequestSummary and mapDiffFile are pure — no network, deterministic output', () => {
    const summary = mapMergeRequestSummary(mr(1) as never, 'g/p')
    expect(summary.projectId).toBe('g/p')
    const file = mapDiffFile({ old_path: 'a', new_path: 'a', diff: '', deleted_file: false })
    expect(file.collapsed).toBe(true)
  })
})

describe('listDiffs — /diffs is not reliable everywhere', () => {
  const diffFile = (path: string, diff = '@@ -1 +1 @@\n+x\n') => ({
    old_path: path, new_path: path, diff, new_file: false, renamed_file: false, deleted_file: false,
  })

  it('uses /diffs when the instance serves it, and never calls /changes', async () => {
    route('GET', '/merge_requests/6/diffs', [diffFile('a.ts')])

    const files = await client().listDiffs('grp/svc', 6)

    expect(files.map((f) => f.newPath)).toEqual(['a.ts'])
    expect(calls.some((c) => c.url.includes('/changes'))).toBe(false)
  })

  /** The real failure: GitLab 17.5.1 answers 500 on /diffs for an MR /changes returns fine. */
  it('falls back to /changes when /diffs answers 500', async () => {
    route('GET', '/merge_requests/6/diffs', {}, 500)
    route('GET', '/merge_requests/6/changes', { changes: [diffFile('a.ts'), diffFile('b.ts')] })

    const files = await client().listDiffs('grp/svc', 6)

    expect(files.map((f) => f.newPath)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]!.collapsed).toBe(false)
  })

  it('falls back when /diffs is absent entirely (404 on an older instance)', async () => {
    route('GET', '/merge_requests/6/diffs', {}, 404)
    route('GET', '/merge_requests/6/changes', { changes: [diffFile('a.ts')] })

    expect((await client().listDiffs('grp/svc', 6)).map((f) => f.newPath)).toEqual(['a.ts'])
  })

  it('does NOT fall back on 401 — a token problem must surface, not be papered over', async () => {
    route('GET', '/merge_requests/6/diffs', {}, 401)
    route('GET', '/merge_requests/6/changes', { changes: [diffFile('a.ts')] })

    await expect(client().listDiffs('grp/svc', 6)).rejects.toThrow(/401/)
    expect(calls.some((c) => c.url.includes('/changes'))).toBe(false)
  })

  it('does NOT fall back on 403 or 429 either', async () => {
    for (const status of [403, 429]) {
      calls = []
      routes = []
      route('GET', '/merge_requests/6/diffs', {}, status)
      route('GET', '/merge_requests/6/changes', { changes: [diffFile('a.ts')] })

      await expect(client().listDiffs('grp/svc', 6)).rejects.toThrow(String(status))
      expect(calls.some((c) => c.url.includes('/changes'))).toBe(false)
    }
  })

  it('the fallback is STICKY: /diffs is probed once per client, not once per merge request', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [diffFile('a.ts')] })
    const c = client()

    await c.listDiffs('grp/svc', 6)
    await c.listDiffs('grp/svc', 7)
    await c.listDiffs('grp/svc', 8)

    expect(calls.filter((x) => x.url.includes('/diffs')).length).toBe(1)
    expect(calls.filter((x) => x.url.includes('/changes')).length).toBe(3)
  })

  it('diffEndpoint: "changes" skips the probe entirely', async () => {
    route('GET', '/changes', { changes: [diffFile('a.ts')] })

    await client({ diffEndpoint: 'changes' }).listDiffs('grp/svc', 6)

    expect(calls.some((x) => x.url.includes('/diffs'))).toBe(false)
  })

  it('diffEndpoint: "diffs" surfaces the 500 instead of falling back', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [diffFile('a.ts')] })

    await expect(client({ diffEndpoint: 'diffs' }).listDiffs('grp/svc', 6)).rejects.toThrow(/500/)
    expect(calls.some((x) => x.url.includes('/changes'))).toBe(false)
  })

  it('never puts a response body in the fallback error', async () => {
    route('GET', '/diffs', { message: 'glpat-should-never-appear' }, 401)

    await expect(client().listDiffs('grp/svc', 6)).rejects.toThrow(
      expect.not.stringContaining('glpat-should-never-appear') as unknown as string,
    )
  })
})

describe('listDiffs — externally stored diffs come back empty without access_raw_diffs', () => {
  const empty = (path: string) => ({ old_path: path, new_path: path, diff: '', deleted_file: false })
  const full = (path: string) => ({ old_path: path, new_path: path, diff: '@@ -1 +1 @@\n+x\n', deleted_file: false })

  it('retries with access_raw_diffs=true when EVERY file body is empty, and uses the real diffs', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [empty('a.ts')] })
    // Registered last so it is matched first — the harness checks newest route
    // first, and this one is the more specific of the two /changes matchers.
    routes.unshift({
      match: (m, u) => m === 'GET' && u.includes('/changes') && u.includes('access_raw_diffs=true'),
      status: 200,
      json: { changes: [full('a.ts')] },
    })

    const files = await client().listDiffs('grp/svc', 6)

    expect(files[0]!.diff).toContain('+x')
    expect(files[0]!.collapsed).toBe(false)
    expect(calls.some((c) => c.url.includes('access_raw_diffs=true'))).toBe(true)
  })

  it('does NOT spend the extra request when the bodies are already present', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [full('a.ts')] })

    await client().listDiffs('grp/svc', 6)

    expect(calls.some((c) => c.url.includes('access_raw_diffs=true'))).toBe(false)
  })

  it('keeps the genuinely collapsed result when the retry also comes back empty', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [empty('big.bin')] })

    const files = await client().listDiffs('grp/svc', 6)

    expect(files[0]!.collapsed).toBe(true)
  })

  it('a deleted file with an empty body is not mistaken for an offloaded diff', async () => {
    route('GET', '/diffs', {}, 500)
    route('GET', '/changes', { changes: [{ old_path: 'gone.ts', new_path: 'gone.ts', diff: '', deleted_file: true }] })

    const files = await client().listDiffs('grp/svc', 6)

    expect(files[0]!.collapsed).toBe(false)
    expect(calls.some((c) => c.url.includes('access_raw_diffs=true'))).toBe(false)
  })
})
