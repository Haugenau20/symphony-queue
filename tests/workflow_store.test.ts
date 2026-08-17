import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkflowStore } from '../src/workflow_store.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `symphony-ws-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('WorkflowStore', () => {
  it('loads workflow file on creation', () => {
    writeFileSync(join(testDir, 'WORKFLOW.md'), '---\ntracker:\n  kind: file_queue\n---\n\nDo work.')
    const store = new WorkflowStore(join(testDir, 'WORKFLOW.md'))
    expect(store.workflow).not.toBeNull()
    expect(store.config!.tracker.kind).toBe('file_queue')
  })

  it('returns null workflow for missing file', () => {
    const store = new WorkflowStore('/nonexistent/WORKFLOW.md')
    expect(store.workflow).toBeNull()
    expect(store.lastError).toContain('not found')
  })

  // The store used to watch the file and reload on change. It reloaded a copy
  // nobody read — main.ts takes config and promptTemplate once and hands the
  // values to the orchestrator and the runner — so an edit logged
  // 'workflow_file_changed' and altered nothing about the running pipeline,
  // which is worse than not reloading at all: the log said it had.
  //
  // Config is read once, at startup. This test states that as the contract
  // rather than leaving it to be inferred, so that re-adding a watcher has to
  // be a deliberate act that updates this test, and comes with the pieces the
  // old one lacked — surviving an atomic save, keeping the last good version
  // when a file is half-written, and moving completion_marker with the prompt.
  it('does NOT reload when the file changes — config is read once, at startup', async () => {
    const path = join(testDir, 'WORKFLOW.md')
    writeFileSync(path, '---\ntracker:\n  kind: file_queue\n---\n\nOriginal prompt.')
    const store = new WorkflowStore(path)
    expect(store.workflow!.promptTemplate).toContain('Original prompt.')

    // Rewrite in place, then give any watcher far longer than it would need.
    writeFileSync(path, '---\ntracker:\n  kind: file_queue\n---\n\nEdited prompt.')
    await new Promise((r) => setTimeout(r, 150))

    expect(store.workflow!.promptTemplate).toContain('Original prompt.')
    expect(store.workflow!.promptTemplate).not.toContain('Edited prompt.')
  })

  it('exposes no watcher lifecycle to manage', () => {
    writeFileSync(join(testDir, 'WORKFLOW.md'), '---\ntracker:\n  kind: file_queue\n---\n\nDo work.')
    const store = new WorkflowStore(join(testDir, 'WORKFLOW.md')) as unknown as Record<string, unknown>

    // There is nothing to close and no callback to register, so a caller
    // cannot be left holding a resource it forgot to release — main.ts's
    // shutdown path no longer has to know this type exists.
    expect(store.close).toBeUndefined()
    expect(store.onChange).toBeUndefined()
  })
})
