import { describe, it, expect } from 'vitest'
import { renderPrompt } from '../src/prompt_builder.js'
import type { Issue } from '../src/models.js'

const testIssue: Issue = {
  id: 'abc-123',
  identifier: 'MT-649',
  title: 'Fix login bug',
  state: 'In Progress',
  description: 'Users cannot log in',
  priority: 1,
  branchName: null,
  url: null,
  labels: ['bug', 'auth'],
  blockedBy: [],
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-02'),
}

describe('renderPrompt', () => {
  it('renders basic issue variables', () => {
    const result = renderPrompt('Work on {{ issue.identifier }}: {{ issue.title }}.', testIssue, null)
    expect(result).toBe('Work on MT-649: Fix login bug.')
  })

  it('renders with attempt', () => {
    const result = renderPrompt('Attempt {{ attempt }}.', testIssue, 2)
    expect(result).toBe('Attempt 2.')
  })

  it('fails on unknown variable', () => {
    expect(() => renderPrompt('{{ unknown_var }}', testIssue, null)).toThrow()
  })
})
