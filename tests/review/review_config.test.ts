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

describe('validateReviewConfig — the permissions block must match what is enforced', () => {
  for (const perm of ['bash', 'webfetch']) {
    it(`refuses to start when agent.permissions.${perm} tries to allow`, () => {
      const wf = review({}, { permissions: { [perm]: 'allow' } })

      const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

      expect(errors.some((x) => x.includes(`agent.permissions.${perm}`))).toBe(true)
    })
  }

  /**
   * The other direction, and the one that matters after the edit-permission
   * fix: a REVIEW.md claiming the agent cannot write is not a harmless
   * over-statement. Writing FINDINGS.json is how a review is produced at all,
   * so a file asserting `edit: deny` describes a pipeline that cannot work.
   */
  it('refuses a block that claims edit is denied — that would describe a reviewer that cannot produce a review', () => {
    const wf = review({}, { permissions: { edit: 'deny' } })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors.some((x) => x.includes('agent.permissions.edit'))).toBe(true)
    expect(errors[0]).toContain('always sets it to "allow"')
  })

  it('accepts a block that correctly documents the real set', () => {
    const wf = review({}, {
      permissions: { edit: 'allow', external_directory: 'allow', bash: 'deny', webfetch: 'deny' },
    })

    expect(validateReviewConfig(buildReviewConfig(wf, env()), env())).toEqual([])
  })

  /**
   * The other half of the same lesson as the `edit: deny` case. The sandbox sits
   * outside the OpenCode server's project root, so denying external_directory
   * locks the agent out of its own workspace — reads slipped through and every
   * write was refused. A REVIEW.md asserting that denial describes a reviewer
   * that cannot work, so it is a startup error rather than a reassuring line.
   */
  it('refuses a block claiming external_directory is denied — that locks the agent out of its sandbox', () => {
    const wf = review({}, { permissions: { external_directory: 'deny' } })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors.some((x) => x.includes('agent.permissions.external_directory'))).toBe(true)
    expect(errors[0]).toContain('always sets it to "allow"')
  })

  it('accepts an absent permissions block — the code enforces the set either way', () => {
    expect(validateReviewConfig(buildReviewConfig(review(), env()), env())).toEqual([])
  })

  it('rejects a permission name this pipeline does not set at all, rather than ignoring it', () => {
    const wf = review({}, { permissions: { telepathy: 'deny' } })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not a permission this pipeline sets')
  })

  it('a mismatch is an error even when it is the only problem', () => {
    const wf = review({}, { permissions: { bash: 'ask' } })

    const errors = validateReviewConfig(buildReviewConfig(wf, env()), env())

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('cannot change it')
  })
})

describe('buildReviewConfig — phase 2 knobs', () => {
  it('defaults: generated files excluded, critique ON, checkout OFF', () => {
    const cfg = buildReviewConfig(review(), env())

    // Generated files are excluded by GitLab's own flag rather than guessed at
    // with patterns, and that is the useful default.
    expect(cfg.excludeGenerated).toBe(true)
    // Noise is the failure mode that costs something, so the pass that attacks
    // it is on unless someone deliberately turns it off.
    expect(cfg.critique).toBe(true)
    // A clone per review is real wall-clock and real disk, so this one is opt-in.
    expect(cfg.checkout).toBe(false)
    expect(cfg.maxChunks).toBe(20)
    expect(cfg.critiqueTimeoutMs).toBe(600_000)
  })

  it('a phase 1 config that set only max_diff_bytes keeps its meaning', () => {
    // The upgrade path that matters: chunk and context budgets both fall back
    // to the single cap phase 1 had, so an existing REVIEW.md does not silently
    // start chunking at a different size than the operator chose.
    const cfg = buildReviewConfig(review({ max_diff_bytes: 123456 }), env())

    expect(cfg.maxChunkBytes).toBe(123456)
    expect(cfg.maxContextBytes).toBe(123456)
  })

  it('chunk and context budgets can be set independently of each other', () => {
    const cfg = buildReviewConfig(
      review({ max_diff_bytes: 100, max_chunk_bytes: 200, max_context_bytes: 300 }),
      env(),
    )

    expect(cfg.maxDiffBytes).toBe(100)
    expect(cfg.maxChunkBytes).toBe(200)
    expect(cfg.maxContextBytes).toBe(300)
  })

  it('every phase 2 switch can be turned the other way', () => {
    const cfg = buildReviewConfig(
      review({ exclude_generated: false, critique: false, checkout: true, max_chunks: 3 }),
      env(),
    )

    expect(cfg.excludeGenerated).toBe(false)
    expect(cfg.critique).toBe(false)
    expect(cfg.checkout).toBe(true)
    expect(cfg.maxChunks).toBe(3)
  })

  it('the checkout still has no config key that could hold a credential', () => {
    // The checkout is the one phase 2 feature that needs the token, and the
    // rule is unchanged: it comes from the environment, and no config file can
    // supply it. Turning the checkout ON must not create a place to put one.
    const cfg = buildReviewConfig(review({ checkout: true }), env())

    expect(JSON.stringify(cfg)).not.toContain('tok')
    expect(Object.keys(cfg)).not.toContain('token')
  })
})
