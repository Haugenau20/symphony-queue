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
})
