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
    expect(cfg.maxParallelReviewAgents).toBe(cfg.maxConcurrentReviews)
    expect(cfg.reviewers).toEqual([
      { id: 'default', primary: true, instructions: '', maxChunks: null },
    ])
    expect(cfg.agent.completionMarker).toBe('SYMPHONY_REVIEW_DONE')
  })

  it('defaults the session ceiling to a customized merge-request ceiling', () => {
    const cfg = buildReviewConfig(review({ max_concurrent_reviews: 7 }), env())

    expect(cfg.maxConcurrentReviews).toBe(7)
    expect(cfg.maxParallelReviewAgents).toBe(7)
  })

  it('normalizes named reviewer profiles and an explicit session ceiling', () => {
    const cfg = buildReviewConfig(review({
      max_parallel_review_agents: 6,
      reviewers: [
        { id: 'general', primary: true, instructions: 'Review correctness.' },
        { id: 'error_paths', instructions: 'Review failure paths.', max_chunks: 2 },
      ],
    }), env())

    expect(cfg.maxParallelReviewAgents).toBe(6)
    expect(cfg.reviewers).toEqual([
      { id: 'general', primary: true, instructions: 'Review correctness.', maxChunks: null },
      { id: 'error_paths', primary: false, instructions: 'Review failure paths.', maxChunks: 2 },
    ])
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

describe('validateReviewConfig — reviewer profiles', () => {
  it('accepts one unconditional primary and bounded supplemental reviewers', () => {
    const cfg = buildReviewConfig(review({
      reviewers: [
        { id: 'general', primary: true, instructions: 'Review broadly.' },
        { id: 'security', instructions: 'Review trust boundaries.', max_chunks: 2 },
        { id: 'reliability', instructions: 'Review concurrency and retries.' },
      ],
    }), env())

    expect(validateReviewConfig(cfg, env())).toEqual([])
  })

  it('rejects an explicitly empty reviewer list', () => {
    const errors = validateReviewConfig(
      buildReviewConfig(review({ reviewers: [] }), env()),
      env(),
    )

    expect(errors.some((x) => x.includes('at least one reviewer'))).toBe(true)
    expect(errors.some((x) => x.includes('exactly one primary'))).toBe(true)
  })

  it('requires exactly one primary reviewer', () => {
    const noPrimary = validateReviewConfig(buildReviewConfig(review({
      reviewers: [{ id: 'general' }, { id: 'security', max_chunks: 2 }],
    }), env()), env())
    const twoPrimaries = validateReviewConfig(buildReviewConfig(review({
      reviewers: [
        { id: 'general', primary: true },
        { id: 'security', primary: true },
      ],
    }), env()), env())

    expect(noPrimary.some((x) => x.includes('exactly one primary') && x.includes('found 0'))).toBe(true)
    expect(twoPrimaries.some((x) => x.includes('exactly one primary') && x.includes('found 2'))).toBe(true)
  })

  it('requires the primary reviewer to remain eligible for every chunk count', () => {
    const errors = validateReviewConfig(buildReviewConfig(review({
      reviewers: [{ id: 'general', primary: true, max_chunks: 2 }],
    }), env()), env())

    expect(errors.some((x) => x.includes('primary') && x.includes('cannot set max_chunks'))).toBe(true)
  })

  it('requires unique safe reviewer ids', () => {
    const errors = validateReviewConfig(buildReviewConfig(review({
      reviewers: [
        { id: 'General Review', primary: true },
        { id: 'duplicate' },
        { id: 'duplicate', max_chunks: 2 },
      ],
    }), env()), env())

    expect(errors.some((x) => x.includes('General Review') && x.includes('lowercase'))).toBe(true)
    expect(errors.some((x) => x.includes('ids must be unique') && x.includes('duplicate'))).toBe(true)
  })

  it('rejects non-positive max_chunks and max_parallel_review_agents structurally', () => {
    expect(() => buildReviewConfig(review({
      max_parallel_review_agents: 0,
    }), env())).toThrow()
    expect(() => buildReviewConfig(review({
      reviewers: [
        { id: 'general', primary: true },
        { id: 'security', max_chunks: 0 },
      ],
    }), env())).toThrow()
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

describe('validateReviewConfig — skip_forks documents a boundary, it cannot move one', () => {
  it('refuses to start when skip_forks is false, rather than silently ignoring it', () => {
    // The key was parsed and exposed and read by nothing: forks are skipped
    // unconditionally in classifySkipReason. Making it live would be worse than
    // the lie — a project access token makes a fork's source project answer 404
    // rather than a denial, so `skip_forks: false` would not enable fork review,
    // it would produce a reviewer that fetches nothing and reports nothing.
    const errors = validateReviewConfig(buildReviewConfig(review({ skip_forks: false }), env()), env())

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('skip_forks cannot be false')
    expect(errors[0]).toContain('404')
  })

  it('true, and absent, are both fine', () => {
    expect(validateReviewConfig(buildReviewConfig(review({ skip_forks: true }), env()), env())).toHaveLength(0)
    expect(validateReviewConfig(buildReviewConfig(review(), env()), env())).toHaveLength(0)
  })
})

describe('buildReviewConfig — phase 3, inline discussions', () => {
  it('defaults ON, which deliberately disagrees with design §14', () => {
    const cfg = buildReviewConfig(review(), env())

    // Design §14 says "behind a config flag, default off, until it has run
    // against real MRs", and the phase 3 brief repeated it. The owner decided
    // otherwise: this deployment is not live anywhere and watches one test
    // repository, so shipping it off would only mean turning it on by hand
    // immediately. Asserted rather than left implicit precisely BECAUSE it
    // contradicts the design document — a future reader comparing the two
    // should find the disagreement pinned down, not discover it by surprise.
    expect(cfg.inlineComments).toBe(true)
  })

  it('can be turned off, which is the first move if a comment lands on a wrong line', () => {
    const cfg = buildReviewConfig(review({ inline_comments: false }), env())
    expect(cfg.inlineComments).toBe(false)
  })

  it('turning it on creates no place to put a credential', () => {
    // Same check the checkout flag gets. Inline publishing needs the token the
    // controller already holds; it must not introduce a config key that could
    // carry one, because no secret may enter config from a file.
    const cfg = buildReviewConfig(review({ inline_comments: true }), env())
    const serialized = JSON.stringify(cfg)
    expect(serialized).not.toContain('glpat')
    expect(serialized.toLowerCase()).not.toContain('token')
  })
})

describe('buildReviewConfig — diff_endpoint', () => {
  it('defaults to auto, which probes /diffs once per process', () => {
    expect(buildReviewConfig(review(), env()).diffEndpoint).toBe('auto')
  })

  it('can be pinned to changes, for an instance whose /diffs is permanently broken', () => {
    // GitLab 17.5.1 answers 500 on /diffs for some merge requests. `auto`
    // handles it correctly but spends one failed request per process and logs
    // a warning on every restart that reads like a fault. Pinning removes both.
    expect(buildReviewConfig(review({ diff_endpoint: 'changes' }), env()).diffEndpoint).toBe('changes')
  })

  it('rejects a value that is not one of the three', () => {
    expect(() => buildReviewConfig(review({ diff_endpoint: 'nonsense' }), env())).toThrow()
  })
})
