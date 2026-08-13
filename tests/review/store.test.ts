import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryReviewStore } from '../../src/review/store.js'
import type { ReviewJob, ReviewJobKey } from '../../src/review/types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'symphony-review-store-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function store(overrides?: { maxAttempts?: number }): DirectoryReviewStore {
  return new DirectoryReviewStore({ root, createIfMissing: true, maxAttempts: overrides?.maxAttempts })
}

function key(overrides: Partial<ReviewJobKey> = {}): ReviewJobKey {
  return { projectId: 'my-org/service-a', mrIid: 412, headSha: 'deadbeef', ...overrides }
}

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    key: key(),
    baseSha: 'base123',
    startSha: 'start123',
    title: 'Fix the thing',
    webUrl: 'https://gitlab.example/my-org/service-a/-/merge_requests/412',
    state: 'discovered',
    attempts: 0,
    nextRetryAt: null,
    discoveredAt: new Date('2026-08-10T09:14:22.000Z'),
    publishedNoteId: null,
    skipReason: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('put / get round-trip', () => {
  it('round-trips every field, including dates, exactly', async () => {
    const s = store()
    const original = job({
      state: 'discovered',
      attempts: 2,
      nextRetryAt: new Date('2026-08-11T10:00:00.000Z'),
      publishedNoteId: 'note-9',
      skipReason: 'draft',
    })
    await s.put(original)
    const found = await s.get(original.key)
    expect(found).toEqual(original)
    expect(found!.discoveredAt).toBeInstanceOf(Date)
    expect(found!.nextRetryAt).toBeInstanceOf(Date)
    expect(found!.discoveredAt.getTime()).toBe(original.discoveredAt.getTime())
    expect(found!.nextRetryAt!.getTime()).toBe(original.nextRetryAt!.getTime())
  })

  it('round-trips null date and null string fields as null, not undefined or missing', async () => {
    const s = store()
    const original = job({ nextRetryAt: null, publishedNoteId: null, skipReason: null, webUrl: null })
    await s.put(original)
    const found = await s.get(original.key)
    expect(found!.nextRetryAt).toBeNull()
    expect(found!.publishedNoteId).toBeNull()
    expect(found!.skipReason).toBeNull()
    expect(found!.webUrl).toBeNull()
  })

  it('returns null for a key that was never stored', async () => {
    const s = store()
    expect(await s.get(key({ headSha: 'nonexistent' }))).toBeNull()
  })

  it('a discovered record lives under projects/<encoded-project>/<mrIid>/<headSha>.json', async () => {
    const s = store()
    await s.put(job())
    const expected = join(root, 'projects', encodeURIComponent('my-org/service-a'), '412', `${encodeURIComponent('deadbeef')}.json`)
    expect(existsSync(expected)).toBe(true)
  })
})

describe('claim() — rename(2) is the claim', () => {
  it('claims a discovered record, moving it out of projects/ and into claimed/', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'discovered' }))
    const claimed = await s.claim(k)
    expect(claimed).toBe(true)

    const discoveredPath = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid), `${encodeURIComponent(k.headSha)}.json`)
    expect(existsSync(discoveredPath)).toBe(false)

    const found = await s.get(k)
    expect(found!.state).toBe('claimed')
  })

  it('resolves false, and does not throw, when the record is already gone', async () => {
    const s = store()
    const k = key()
    await expect(s.claim(k)).resolves.toBe(false)
  })

  it('resolves false on a second claim of an already-claimed key', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    expect(await s.claim(k)).toBe(true)
    await expect(s.claim(k)).resolves.toBe(false)
  })

  it('exactly one of two concurrent claims on the same key wins; the loser resolves false rather than throwing', async () => {
    // Real concurrent fs.rename race: both calls pass the initial lookup
    // (locateClaimable does not remove anything), then race on the rename
    // itself, which is where the ENOENT-vs-throw behaviour actually lives. A
    // saboteur who removes the try/catch around rename would make this test
    // throw instead of resolving [true, false].
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    const results = await Promise.all([s.claim(k), s.claim(k)])
    expect(results.filter((r) => r === true)).toHaveLength(1)
    expect(results.filter((r) => r === false)).toHaveLength(1)
  })

  it('can claim a due failed record (retry path), not only a fresh discovered one', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() - 1000) }))
    expect(await s.claim(k)).toBe(true)
    const found = await s.get(k)
    expect(found!.state).toBe('claimed')
  })
})

describe('update() — state-driven relocation', () => {
  it('moves a claimed record to failed/ when marked failed, and it disappears from claimed/', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    await s.claim(k)
    const running = await s.get(k)
    await s.update({ ...running!, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() + 60000) })

    expect(readdirSync(join(root, 'claimed')).filter((f) => f.endsWith('.json'))).toHaveLength(0)
    expect(readdirSync(join(root, 'failed')).filter((f) => f.endsWith('.json'))).toHaveLength(1)

    const found = await s.get(k)
    expect(found!.state).toBe('failed')
    expect(found!.attempts).toBe(1)
  })

  it('moves a claimed record back to projects/ when it reaches a terminal state', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    await s.claim(k)
    const running = await s.get(k)
    await s.update({ ...running!, state: 'published', publishedNoteId: 'note-1' })

    expect(readdirSync(join(root, 'claimed')).filter((f) => f.endsWith('.json'))).toHaveLength(0)
    const projectFile = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid), `${encodeURIComponent(k.headSha)}.json`)
    expect(existsSync(projectFile)).toBe(true)

    const found = await s.get(k)
    expect(found!.state).toBe('published')
    expect(found!.publishedNoteId).toBe('note-1')
  })

  it('rewrites content in place, without a stray duplicate, for a same-location transition', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    await s.claim(k)
    const claimed = await s.get(k)
    await s.update({ ...claimed!, state: 'running' })
    await s.update({ ...claimed!, state: 'publishing' })

    const files = readdirSync(join(root, 'claimed')).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const found = await s.get(k)
    expect(found!.state).toBe('publishing')
  })
})

describe('malformed records', () => {
  it('a malformed JSON record is skipped, not thrown, on get()', async () => {
    const s = store()
    const k = key()
    const dir = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${encodeURIComponent(k.headSha)}.json`), '{ not valid json', 'utf-8')

    await expect(s.get(k)).resolves.toBeNull()
  })

  it('a record that fails schema validation (wrong type) is skipped, not thrown', async () => {
    const s = store()
    const k = key()
    const dir = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${encodeURIComponent(k.headSha)}.json`),
      JSON.stringify({ ...job(), attempts: 'not-a-number' }),
      'utf-8',
    )
    await expect(s.get(k)).resolves.toBeNull()
  })

  it('a malformed record is never deleted or repaired — it stays on disk for a human to look at', async () => {
    const s = store()
    const k = key()
    const dir = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${encodeURIComponent(k.headSha)}.json`)
    writeFileSync(path, 'not json at all', 'utf-8')

    await s.get(k)
    expect(existsSync(path)).toBe(true)
    expect((await readFile(path, 'utf-8'))).toBe('not json at all')
  })

  it('a malformed record does not throw out of listClaimable, and is simply absent from the results', async () => {
    const s = store()
    const k = key()
    const dir = join(root, 'projects', encodeURIComponent(k.projectId), String(k.mrIid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${encodeURIComponent(k.headSha)}.json`), '{{{', 'utf-8')

    await expect(s.listClaimable(new Date())).resolves.toEqual([])
  })
})

describe('listClaimable', () => {
  it('returns discovered records', async () => {
    const s = store()
    await s.put(job({ key: key({ mrIid: 1, headSha: 'a' }) }))
    await s.put(job({ key: key({ mrIid: 2, headSha: 'b' }) }))
    const claimable = await s.listClaimable(new Date())
    expect(claimable.map((j) => j.key.headSha).sort()).toEqual(['a', 'b'])
  })

  it('excludes a record once it has been claimed', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    await s.claim(k)
    expect(await s.listClaimable(new Date())).toEqual([])
  })

  it('excludes a terminal (published) record', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'published', publishedNoteId: 'n1' }))
    expect(await s.listClaimable(new Date())).toEqual([])
  })

  it('includes a failed record whose nextRetryAt is due', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() - 1000) }))
    const claimable = await s.listClaimable(new Date())
    expect(claimable.map((j) => j.key.headSha)).toEqual([k.headSha])
  })

  it('excludes a failed record whose nextRetryAt is still in the future', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() + 60 * 60 * 1000) }))
    expect(await s.listClaimable(new Date())).toEqual([])
  })

  it('treats a failed record with a null nextRetryAt as due', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 1, nextRetryAt: null }))
    const claimable = await s.listClaimable(new Date())
    expect(claimable.map((j) => j.key.headSha)).toEqual([k.headSha])
  })

  it('never returns a record at or beyond maxAttempts, even if nextRetryAt is due', async () => {
    const s = store({ maxAttempts: 3 })
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 3, nextRetryAt: new Date(Date.now() - 1000) }))
    expect(await s.listClaimable(new Date())).toEqual([])
  })

  it('defaults maxAttempts to 3 when not configured', async () => {
    const s = new DirectoryReviewStore({ root, createIfMissing: true })
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 2, nextRetryAt: new Date(Date.now() - 1000) }))
    expect(await s.listClaimable(new Date())).toHaveLength(1)
    await s.update({ ...(await s.get(k))!, attempts: 3, nextRetryAt: new Date(Date.now() - 1000) })
    expect(await s.listClaimable(new Date())).toHaveLength(0)
  })

  it('maxAttempts is configurable via the constructor, independent of the default', async () => {
    const s = store({ maxAttempts: 1 })
    const k = key()
    await s.put(job({ key: k, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() - 1000) }))
    expect(await s.listClaimable(new Date())).toEqual([])
  })
})

describe('recoverInFlight', () => {
  it('returns records that were claimed/running/publishing at startup', async () => {
    const s = store()
    const a = key({ mrIid: 1, headSha: 'a' })
    const b = key({ mrIid: 2, headSha: 'b' })
    await s.put(job({ key: a }))
    await s.put(job({ key: b }))
    await s.claim(a)
    await s.claim(b)
    const found = await s.get(b)
    await s.update({ ...found!, state: 'running' })

    const inFlight = await s.recoverInFlight()
    expect(inFlight.map((j) => j.key.headSha).sort()).toEqual(['a', 'b'])
  })

  it('does not include a discovered (never claimed) record', async () => {
    const s = store()
    await s.put(job())
    expect(await s.recoverInFlight()).toEqual([])
  })

  it('does not include a terminal or failed record', async () => {
    const s = store()
    const k1 = key({ mrIid: 1, headSha: 'a' })
    const k2 = key({ mrIid: 2, headSha: 'b' })
    await s.put(job({ key: k1, state: 'published' }))
    await s.put(job({ key: k2, state: 'failed', attempts: 1 }))
    expect(await s.recoverInFlight()).toEqual([])
  })

  it('a fresh store instance over the same root sees a prior instance\'s claimed records — this is what makes recovery free', async () => {
    const first = store()
    const k = key()
    await first.put(job({ key: k }))
    await first.claim(k)

    const second = new DirectoryReviewStore({ root })
    const inFlight = await second.recoverInFlight()
    expect(inFlight.map((j) => j.key.headSha)).toEqual([k.headSha])
  })
})

describe('cursor', () => {
  it('returns null when no cursor has ever been written', async () => {
    const s = store()
    expect(await s.readCursor()).toBeNull()
  })

  it('round-trips a written cursor', async () => {
    const s = store()
    const at = new Date('2026-08-10T09:14:22.000Z')
    await s.writeCursor(at)
    const read = await s.readCursor()
    expect(read).toBeInstanceOf(Date)
    expect(read!.getTime()).toBe(at.getTime())
  })

  it('overwrites the previous cursor atomically on a second write', async () => {
    const s = store()
    await s.writeCursor(new Date('2026-08-01T00:00:00Z'))
    await s.writeCursor(new Date('2026-08-10T00:00:00Z'))
    const read = await s.readCursor()
    expect(read!.toISOString()).toBe('2026-08-10T00:00:00.000Z')
  })

  it('returns null, without throwing, for a malformed cursor file', async () => {
    const s = store()
    writeFileSync(join(root, 'cursor.json'), 'not json', 'utf-8')
    await expect(s.readCursor()).resolves.toBeNull()
  })
})

describe('atomic writes', () => {
  it('never leaves a .tmp file behind after a successful write', async () => {
    const s = store()
    await s.put(job())
    const dir = join(root, 'projects', encodeURIComponent(key().projectId), String(key().mrIid))
    const files = readdirSync(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('a reader never observes a torn write: concurrent updates each leave a fully valid record', async () => {
    const s = store()
    const k = key()
    await s.put(job({ key: k }))
    await s.claim(k)
    const base = await s.get(k)
    await Promise.all([
      s.update({ ...base!, state: 'running', title: 'A' }),
      s.update({ ...base!, state: 'running', title: 'B' }),
    ])
    const found = await s.get(k)
    expect(['A', 'B']).toContain(found!.title)
  })
})

describe('path containment — a hostile project id cannot escape the store root', () => {
  it('rejects a project id that is exactly ".." (a real escape from projects/)', async () => {
    const s = store()
    const hostile = key({ projectId: '..' })
    await expect(s.put(job({ key: hostile }))).rejects.toThrow()
  })

  it('accepts a project id that merely begins with two dots, rather than rejecting it as traversal', async () => {
    const s = store()
    const k = key({ projectId: '..foo' })
    await expect(s.put(job({ key: k }))).resolves.not.toThrow()
    const found = await s.get(k)
    expect(found).not.toBeNull()
    expect(found!.key.projectId).toBe('..foo')
  })

  it('a project id containing slashes is flattened into one safe directory segment, never escaping the root', async () => {
    const s = store()
    const hostile = key({ projectId: '../../etc/passwd' })
    await s.put(job({ key: hostile }))

    // Nothing was written outside root: only `projects`, `claimed`, `failed`
    // and cursor.json (once written) live directly under root.
    const topLevel = readdirSync(root)
    expect(topLevel.every((f) => ['projects', 'claimed', 'failed', 'cursor.json'].includes(f))).toBe(true)

    const found = await s.get(hostile)
    expect(found!.key.projectId).toBe('../../etc/passwd')
  })

  it('a project id of "." resolves to the projects/ directory itself — contained, not an escape', async () => {
    // Unlike "..", a single "." does not leave the `projects/` directory, so
    // checkContainment accepts it (as it accepts the root itself — see
    // path_safety.test.ts). Documented here so the boundary between "this
    // input is unusual" and "this input escapes" is explicit.
    const s = store()
    const k = key({ projectId: '.' })
    await expect(s.put(job({ key: k }))).resolves.not.toThrow()
  })
})

describe('listForMergeRequest — phase 2 supersession lookup', () => {
  it('finds records physically located in projects/, claimed/ AND failed/ for the same (project, iid), and excludes a record for a different iid', async () => {
    const s = store()
    const projectId = 'my-org/service-a'
    const mrIid = 500

    // Lives under projects/<project>/<iid>/ — a record in a state that has
    // never moved out of there.
    await s.put(job({ key: key({ projectId, mrIid, headSha: 'sha-discovered' }), state: 'discovered' }))

    // Lives under claimed/ — keyed by a hash of the full key, not derivable
    // from (projectId, mrIid) alone.
    const claimedKey = key({ projectId, mrIid, headSha: 'sha-claimed' })
    await s.put(job({ key: claimedKey, state: 'discovered' }))
    await s.claim(claimedKey)

    // Lives under failed/ — likewise keyed by a hash of the full key.
    const failedKey = key({ projectId, mrIid, headSha: 'sha-failed' })
    await s.put(job({ key: failedKey, state: 'discovered' }))
    await s.claim(failedKey)
    const claimedFailed = await s.get(failedKey)
    await s.update({ ...claimedFailed!, state: 'failed', attempts: 1, nextRetryAt: new Date(Date.now() + 60000) })

    // A record for a DIFFERENT iid, same project — must not be returned.
    await s.put(job({ key: key({ projectId, mrIid: mrIid + 1, headSha: 'sha-other-iid' }) }))
    // A record for a different project, same iid — must not be returned either.
    await s.put(job({ key: key({ projectId: 'my-org/service-b', mrIid, headSha: 'sha-other-project' }) }))

    const found = await s.listForMergeRequest(projectId, mrIid)
    expect(found.map((j) => j.key.headSha).sort()).toEqual(['sha-claimed', 'sha-discovered', 'sha-failed'])
    expect(found.every((j) => j.key.projectId === projectId && j.key.mrIid === mrIid)).toBe(true)

    const states = new Map(found.map((j) => [j.key.headSha, j.state]))
    expect(states.get('sha-discovered')).toBe('discovered')
    expect(states.get('sha-claimed')).toBe('claimed')
    expect(states.get('sha-failed')).toBe('failed')
  })

  it('skips a malformed record with a warning rather than throwing', async () => {
    const s = store()
    const projectId = 'my-org/service-a'
    const mrIid = 501
    await s.put(job({ key: key({ projectId, mrIid, headSha: 'sha-good' }) }))

    const dir = join(root, 'projects', encodeURIComponent(projectId), String(mrIid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${encodeURIComponent('sha-bad')}.json`), 'not json at all', 'utf-8')

    const found = await s.listForMergeRequest(projectId, mrIid)
    expect(found.map((j) => j.key.headSha)).toEqual(['sha-good'])
  })

  it('a malformed record in claimed/ is likewise skipped rather than thrown', async () => {
    const s = store()
    const projectId = 'my-org/service-a'
    const mrIid = 505
    const goodKey = key({ projectId, mrIid, headSha: 'sha-good' })
    await s.put(job({ key: goodKey }))
    await s.claim(goodKey)

    const claimedDir = join(root, 'claimed')
    mkdirSync(claimedDir, { recursive: true })
    writeFileSync(join(claimedDir, 'garbage.json'), '{{{not valid', 'utf-8')

    const found = await s.listForMergeRequest(projectId, mrIid)
    expect(found.map((j) => j.key.headSha)).toEqual(['sha-good'])
  })

  it('returns records newest-discovered first', async () => {
    const s = store()
    const projectId = 'my-org/service-a'
    const mrIid = 502
    await s.put(job({ key: key({ projectId, mrIid, headSha: 'older' }), discoveredAt: new Date('2026-08-01T00:00:00Z') }))
    await s.put(job({ key: key({ projectId, mrIid, headSha: 'newer' }), discoveredAt: new Date('2026-08-10T00:00:00Z') }))
    const found = await s.listForMergeRequest(projectId, mrIid)
    expect(found.map((j) => j.key.headSha)).toEqual(['newer', 'older'])
  })

  it('returns an empty array when nothing exists for the merge request', async () => {
    const s = store()
    expect(await s.listForMergeRequest('nope/nope', 9999)).toEqual([])
  })

  it('when the same head SHA exists in more than one location, the more "live" copy wins: claimed over failed over discovered', async () => {
    // This can only happen transiently (e.g. mid-transition), but the lookup
    // must still resolve deterministically rather than returning duplicates.
    const s = store()
    const projectId = 'my-org/service-a'
    const mrIid = 503
    const k = key({ projectId, mrIid, headSha: 'sha-x' })
    await s.put(job({ key: k, state: 'discovered' }))
    await s.claim(k)
    const claimed = await s.get(k)
    expect(claimed!.state).toBe('claimed')

    const found = await s.listForMergeRequest(projectId, mrIid)
    expect(found).toHaveLength(1)
    expect(found[0].state).toBe('claimed')
  })

  it('a hostile projectId still goes through checkContainment rather than escaping the store root', async () => {
    const s = store()
    await expect(s.listForMergeRequest('..', 1)).rejects.toThrow()
  })

  it('rejects a non-integer mrIid rather than silently misbehaving', async () => {
    const s = store()
    await expect(s.listForMergeRequest('my-org/service-a', 1.5)).rejects.toThrow()
  })
})

describe('root validation', () => {
  it('throws when the root does not exist and createIfMissing is not set', () => {
    const missing = join(root, 'does-not-exist')
    expect(() => new DirectoryReviewStore({ root: missing })).toThrow()
  })

  it('creates projects/, claimed/ and failed/ when createIfMissing is set', () => {
    const fresh = join(root, 'fresh')
    new DirectoryReviewStore({ root: fresh, createIfMissing: true })
    expect(existsSync(join(fresh, 'projects'))).toBe(true)
    expect(existsSync(join(fresh, 'claimed'))).toBe(true)
    expect(existsSync(join(fresh, 'failed'))).toBe(true)
  })
})
