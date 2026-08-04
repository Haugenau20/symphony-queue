import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceManager } from '../src/workspace.js'
import { execHook } from '../src/hooks.js'

vi.mock('../src/hooks.js', () => ({
  execHook: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', error: null }),
}))

let testRoot: string

beforeEach(() => {
  testRoot = join(tmpdir(), `symphony-ws-test-${Date.now()}`)
  mkdirSync(testRoot, { recursive: true })
})

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

describe('WorkspaceManager', () => {
  it('creates workspace for an issue', () => {
    const wm = new WorkspaceManager({ root: testRoot })
    const ws = wm.createForIssue('ABC-123')
    expect(ws.workspaceKey).toBe('ABC-123')
    expect(existsSync(ws.path)).toBe(true)
    expect(ws.createdNow).toBe(true)
  })

  it('reuses existing workspace', () => {
    const wm = new WorkspaceManager({ root: testRoot })
    const ws1 = wm.createForIssue('ABC-123')
    const ws2 = wm.createForIssue('ABC-123')
    expect(ws1.path).toBe(ws2.path)
    expect(ws1.createdNow).toBe(true)
    expect(ws2.createdNow).toBe(false)
  })

  it('sanitizes workspace key', () => {
    const wm = new WorkspaceManager({ root: testRoot })
    const ws = wm.createForIssue('MT-649: fix bug')
    expect(ws.workspaceKey).toBe('MT-649__fix_bug')
  })

  it('contains a traversal-shaped identifier inside the root', () => {
    const wm = new WorkspaceManager({ root: testRoot })
    const ws = wm.createForIssue('../../etc/passwd')
    expect(ws.workspaceKey).toBe('.._.._etc_passwd')
    expect(ws.path.startsWith(testRoot)).toBe(true)
    expect(existsSync(join(testRoot, '.._.._etc_passwd'))).toBe(true)
  })

  it('fires after_create hook only for a newly created workspace', async () => {
    const wm = new WorkspaceManager({ root: testRoot, afterCreate: 'mock-cmd' })
    const ws = wm.createForIssue('AFTER-1')
    expect(ws.createdNow).toBe(true)
    await wm.runAfterCreate(ws)
    expect(execHook).toHaveBeenCalledWith('mock-cmd', ws.path, 60000)

    vi.mocked(execHook).mockClear()
    const reused = wm.createForIssue('AFTER-1')
    expect(reused.createdNow).toBe(false)
    await wm.runAfterCreate(reused)
    expect(execHook).not.toHaveBeenCalled()
  })

  it('throws when the after_create hook reports failure', async () => {
    vi.mocked(execHook).mockResolvedValueOnce({ success: false, stdout: '', stderr: '', error: 'boom' })
    const wm = new WorkspaceManager({ root: testRoot, afterCreate: 'fail-cmd' })
    const ws = wm.createForIssue('AFTER-2')
    await expect(wm.runAfterCreate(ws)).rejects.toThrow('after_create hook failed')
  })

  it('swallows after_run hook failures', async () => {
    vi.mocked(execHook).mockRejectedValueOnce(new Error('hook exploded'))
    const wm = new WorkspaceManager({ root: testRoot, afterRun: 'fail-cmd' })
    const ws = wm.createForIssue('AFTER-3')
    await expect(wm.runAfterRun(ws)).resolves.toBeUndefined()
  })

  it('removes a workspace', () => {
    const wm = new WorkspaceManager({ root: testRoot })
    const ws = wm.createForIssue('GONE-1')
    expect(existsSync(ws.path)).toBe(true)
    wm.removeForIssue('GONE-1')
    expect(existsSync(ws.path)).toBe(false)
  })
})
