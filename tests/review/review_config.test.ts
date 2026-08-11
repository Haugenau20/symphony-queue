import { describe, it, expect } from 'vitest'
import { buildReviewConfig, validateReviewConfig } from '../../src/config.js'
import type { WorkflowDefinition } from '../../src/models.js'

function review(front: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    config: {
      review: { base_url: 'https://gitlab.example', projects: ['grp/svc'], ...front },
      agent,
    },
    promptTemplate: 'review the change',
  }
}

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SYMPHONY_REVIEW_GITLAB_TOKEN: 'tok',
  SYMPHONY_REVIEW_STORE_ROOT: '/review-store',
  SYMPHONY_REVIEW_WORKSPACES_ROOT: '/review-workspaces',
  ...overrides,
})

describe('buildReviewConfig', () => {
  it('applies the documented defaults', () => {
    const cfg = buildReviewConfig(review(), env())

    expect(cfg.pollIntervalMs).toBe(60000)
    expect(cfg.includeDrafts).toBe(false)
    expect(cfg.skipForks).toBe(true)
    expect(cfg.maxAttempts).toBe(3)
    expect(cfg.maxDiffBytes).toBe(400000)
    expect(cfg.perProjectMaxInFlight).toBe(1)
    expect(cfg.agent.completionMarker).toBe('SYMPHONY_REVIEW_DONE')
  })

  it('takes the store and workspace roots from the environment, not the file', () => {
    const wf = review({ store_root: '/attacker-chosen', workspaces_root: '/attacker-chosen' })

    const cfg = buildReviewConfig(wf, env())

    expect(cfg.storeRoot).toBe('/review-store')
    expect(cfg.workspacesRoot).toBe('/review-workspaces')
  })

  it('there is no config key that can carry the token', () => {
    const wf = review({ token: 'in-the-file', gitlab_token: 'also-in-the-file' })

    const cfg = buildReviewConfig(wf, env())

    expect(JSON.stringify(cfg)).not.toContain('in-the-file')
  })
})

describe('validateReviewConfig', () => {
  it('accepts a well-formed review-only config', () => {
    expect(validateReviewConfig(buildReviewConfig(review(), env()), env())).toEqual([])
  })

  it('requires the token from the environment', () => {
    const e = env()
    delete e.SYMPHONY_REVIEW_GITLAB_TOKEN

    const errors = validateReviewConfig(buildReviewConfig(review(), e), e)

    expect(errors.some((x) => x.includes('SYMPHONY_REVIEW_GITLAB_TOKEN'))).toBe(true)
  })

  it('refuses to watch nothing — neither a group nor any projects', () => {
    const wf: WorkflowDefinition = {
      config: { review: { base_url: 'https://gitlab.example' } },
      promptTemplate: '',
    }

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors.some((x) => x.includes('group_id'))).toBe(true)
  })

  it('accepts a group with no explicit project list', () => {
    const wf: WorkflowDefinition = {
      config: { review: { base_url: 'https://gitlab.example', group_id: 'grp' } },
      promptTemplate: '',
    }

    expect(validateReviewConfig(buildReviewConfig(wf, env()), env())).toEqual([])
  })

  it('requires base_url', () => {
    const wf: WorkflowDefinition = { config: { review: { projects: ['a/b'] } }, promptTemplate: '' }

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors.some((x) => x.includes('base_url'))).toBe(true)
  })

  it('refuses a store root that collides with the workspaces root', () => {
    const e = env({ SYMPHONY_REVIEW_WORKSPACES_ROOT: '/review-store' })

    const errors = validateReviewConfig(buildReviewConfig(review(), e), e)

    expect(errors.some((x) => x.includes('must differ'))).toBe(true)
  })

  it('refuses a reserved floor larger than the review ceiling', () => {
    const wf = review({ max_concurrent_reviews: 2, reserved_review_slots: 3 })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors.some((x) => x.includes('reserved_review_slots'))).toBe(true)
  })
})

describe('validateReviewConfig — the permissions block cannot widen the sandbox', () => {
  for (const perm of ['edit', 'bash', 'webfetch', 'external_directory']) {
    it(`refuses to start when agent.permissions.${perm} tries to allow`, () => {
      const wf = review({}, { permissions: { [perm]: 'allow' } })

      const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

      expect(errors.some((x) => x.includes(`agent.permissions.${perm}`))).toBe(true)
    })
  }

  it('accepts the block when it correctly documents all four denials', () => {
    const wf = review({}, {
      permissions: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
    })

    expect(validateReviewConfig(buildReviewConfig(wf, env()), env())).toEqual([])
  })

  it('accepts an absent permissions block — the code enforces the denials either way', () => {
    expect(validateReviewConfig(buildReviewConfig(review(), env()), env())).toEqual([])
  })

  it('a loosening attempt is an error even when it is the only problem', () => {
    const wf = review({}, { permissions: { bash: 'ask' } })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('cannot widen it')
  })
})
