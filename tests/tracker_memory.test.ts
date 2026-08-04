import { describe, it, expect } from 'vitest'
import { MemoryTracker } from '../src/tracker/memory.js'
import type { Issue } from '../src/models.js'

describe('MemoryTracker', () => {
  it('returns candidate issues in active states', async () => {
    const t = new MemoryTracker(['Todo', 'In Progress'])
    t.addIssue({ id: '1', identifier: 'A-1', title: 't1', state: 'Todo' } as Issue)
    t.addIssue({ id: '2', identifier: 'A-2', title: 't2', state: 'Done' } as Issue)
    const candidates = await t.fetchCandidateIssues()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].id).toBe('1')
  })

  it('returns issues by state names', async () => {
    const t = new MemoryTracker()
    t.addIssue({ id: '1', identifier: 'A-1', title: 't1', state: 'Done' } as Issue)
    t.addIssue({ id: '2', identifier: 'A-2', title: 't2', state: 'Closed' } as Issue)
    const results = await t.fetchIssuesByStates(['Done'])
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('1')
  })

  it('returns issue states by ids', async () => {
    const t = new MemoryTracker()
    t.addIssue({ id: '1', identifier: 'A-1', title: 't1', state: 'Todo' } as Issue)
    const results = await t.fetchIssueStatesByIds(['1'])
    expect(results).toHaveLength(1)
    expect(results[0].state).toBe('Todo')
  })

  it('returns empty array for unknown ids', async () => {
    const t = new MemoryTracker()
    expect(await t.fetchIssueStatesByIds(['nonexistent'])).toEqual([])
  })
})
