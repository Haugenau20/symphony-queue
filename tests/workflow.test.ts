import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadWorkflow } from '../src/workflow.js'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir: string

beforeAll(() => {
  tmpDir = join(tmpdir(), `symphony-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterAll(() => {
  unlinkSync(join(tmpDir, 'WORKFLOW.md'))
})

describe('loadWorkflow', () => {
  it('loads workflow with front matter and prompt body', () => {
    writeFileSync(join(tmpDir, 'WORKFLOW.md'), `---
tracker:
  kind: file_queue
  active_states: [Todo]
agent:
  max_concurrent_agents: 5
---

You are working on {{ issue.identifier }}: {{ issue.title }}.
`)
    const wf = loadWorkflow(join(tmpDir, 'WORKFLOW.md'))
    expect(wf.config).toEqual({
      tracker: { kind: 'file_queue', active_states: ['Todo'] },
      agent: { max_concurrent_agents: 5 },
    })
    expect(wf.promptTemplate).toBe('You are working on {{ issue.identifier }}: {{ issue.title }}.')
  })

  it('handles file without front matter', () => {
    writeFileSync(join(tmpDir, 'WORKFLOW.md'), 'Just a prompt body.')
    const wf = loadWorkflow(join(tmpDir, 'WORKFLOW.md'))
    expect(wf.config).toEqual({})
    expect(wf.promptTemplate).toBe('Just a prompt body.')
  })

  it('throws on missing file', () => {
    expect(() => loadWorkflow('/nonexistent/WORKFLOW.md')).toThrow('Workflow file not found')
  })

  it('throws on non-map front matter', () => {
    writeFileSync(join(tmpDir, 'WORKFLOW.md'), "---\n42\n---\nbody")
    expect(() => loadWorkflow(join(tmpDir, 'WORKFLOW.md'))).toThrow('YAML front matter must decode to a map')
  })

  // Note: null-path default behavior depends on CWD environment,
  // covered by the explicit missing-file test above.
})
