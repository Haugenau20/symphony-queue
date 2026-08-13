import { describe, it, expect } from 'vitest'
import { planReviewMaterial, globToRegExp, isExcludedPath } from '../../src/review/material.js'
import type { MaterialPlannerOptions, MergeRequestDiffFile, ReviewPlan, ReviewPlanRefusal } from '../../src/review/types.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function diffFile(overrides: Partial<MergeRequestDiffFile> = {}): MergeRequestDiffFile {
  return {
    oldPath: 'src/foo.ts',
    newPath: 'src/foo.ts',
    diff: '@@ -1,1 +1,2 @@\n-old\n+new\n+line',
    newFile: false,
    renamedFile: false,
    deletedFile: false,
    generatedFile: false,
    collapsed: false,
    ...overrides,
  }
}

function options(overrides: Partial<MaterialPlannerOptions> = {}): MaterialPlannerOptions {
  return {
    excludePaths: [],
    excludeGenerated: false,
    maxChunkBytes: 10_000,
    maxChunks: 10,
    ...overrides,
  }
}

function asPlan(result: ReturnType<typeof planReviewMaterial>): ReviewPlan {
  expect(result.kind).toBe('plan')
  if (result.kind !== 'plan') throw new Error('unreachable')
  return result
}

function asRefusal(result: ReturnType<typeof planReviewMaterial>): ReviewPlanRefusal {
  expect(result.kind).toBe('refused')
  if (result.kind !== 'refused') throw new Error('unreachable')
  return result
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

// ---------------------------------------------------------------------------
// globToRegExp / isExcludedPath — moved from worker.ts, same behaviour
// ---------------------------------------------------------------------------

describe('globToRegExp / isExcludedPath (moved from worker.ts)', () => {
  it('matches a literal path', () => {
    expect(isExcludedPath('package-lock.json', ['package-lock.json'])).toBe(true)
    expect(isExcludedPath('package.json', ['package-lock.json'])).toBe(false)
  })

  it('* does not cross a path separator', () => {
    expect(isExcludedPath('vendor/foo.go', ['vendor/*'])).toBe(true)
    expect(isExcludedPath('vendor/nested/foo.go', ['vendor/*'])).toBe(false)
  })

  it('** crosses path separators', () => {
    expect(isExcludedPath('vendor/nested/deep/foo.go', ['vendor/**'])).toBe(true)
    expect(isExcludedPath('vendor/foo.go', ['vendor/**'])).toBe(true)
  })

  it('matches by extension', () => {
    expect(isExcludedPath('dist/bundle.min.js', ['**/*.min.js'])).toBe(true)
    expect(isExcludedPath('src/index.ts', ['**/*.min.js'])).toBe(false)
  })

  it('empty pattern list excludes nothing', () => {
    expect(isExcludedPath('anything', [])).toBe(false)
  })

  it('globToRegExp anchors the whole string', () => {
    const re = globToRegExp('foo/*.ts')
    expect(re.test('foo/bar.ts')).toBe(true)
    expect(re.test('xfoo/bar.ts')).toBe(false)
    expect(re.test('foo/bar.tsx')).toBe(false)
  })

  it('? matches exactly one non-separator character', () => {
    expect(isExcludedPath('a.ts', ['?.ts'])).toBe(true)
    expect(isExcludedPath('ab.ts', ['?.ts'])).toBe(false)
  })

  it('escapes regex metacharacters in the literal portion of a pattern', () => {
    expect(isExcludedPath('a.ts', ['a.ts'])).toBe(true)
    expect(isExcludedPath('aXts', ['a.ts'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// exclusion
// ---------------------------------------------------------------------------

describe('planReviewMaterial — exclude_paths', () => {
  it('matches against BOTH oldPath and newPath', () => {
    const renamed = diffFile({ oldPath: 'vendor/old-name.js', newPath: 'src/new-name.js', renamedFile: true })
    const plan = asPlan(planReviewMaterial([renamed], options({ excludePaths: ['vendor/**'] })))
    expect(plan.excluded).toEqual([{ path: 'src/new-name.js', reason: 'exclude_path' }])
    expect(plan.chunks).toHaveLength(0)

    const renamedOther = diffFile({ oldPath: 'src/old-name.js', newPath: 'vendor/new-name.js', renamedFile: true })
    const plan2 = asPlan(planReviewMaterial([renamedOther], options({ excludePaths: ['vendor/**'] })))
    expect(plan2.excluded).toEqual([{ path: 'vendor/new-name.js', reason: 'exclude_path' }])
  })

  it('an excluded file does not contribute a single byte to diffBytes', () => {
    const huge = diffFile({ oldPath: 'vendor/bundle.js', newPath: 'vendor/bundle.js', diff: 'X'.repeat(1_000_000) })
    const small = diffFile({ oldPath: 'src/foo.ts', newPath: 'src/foo.ts', diff: 'small diff' })
    const plan = asPlan(planReviewMaterial([huge, small], options({ excludePaths: ['vendor/**'] })))

    expect(plan.diffBytes).toBe(byteLength('small diff'))
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0]!.diffBytes).toBe(byteLength('small diff'))
    expect(plan.excluded).toEqual([{ path: 'vendor/bundle.js', reason: 'exclude_path' }])
  })
})

describe('planReviewMaterial — generated files', () => {
  it('excludes a generated file with reason "generated" when excludeGenerated is on', () => {
    const gen = diffFile({ oldPath: 'gen/schema.ts', newPath: 'gen/schema.ts', generatedFile: true })
    const plan = asPlan(planReviewMaterial([gen], options({ excludeGenerated: true })))

    expect(plan.excluded).toEqual([{ path: 'gen/schema.ts', reason: 'generated' }])
    expect(plan.chunks).toHaveLength(0)
  })

  it('INCLUDES a generated file when excludeGenerated is off', () => {
    const gen = diffFile({ oldPath: 'gen/schema.ts', newPath: 'gen/schema.ts', generatedFile: true })
    const plan = asPlan(planReviewMaterial([gen], options({ excludeGenerated: false })))

    expect(plan.excluded).toEqual([])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0]!.files).toEqual([gen])
  })

  it('a non-generated file is unaffected by excludeGenerated', () => {
    const ordinary = diffFile({ generatedFile: false })
    const plan = asPlan(planReviewMaterial([ordinary], options({ excludeGenerated: true })))
    expect(plan.excluded).toEqual([])
    expect(plan.chunks).toHaveLength(1)
  })
})

describe('planReviewMaterial — binary files', () => {
  it('excludes a binary diff marker with reason "binary"', () => {
    const bin = diffFile({
      oldPath: 'assets/logo.png',
      newPath: 'assets/logo.png',
      diff: 'Binary files a/assets/logo.png and b/assets/logo.png differ',
    })
    const plan = asPlan(planReviewMaterial([bin], options()))

    expect(plan.excluded).toEqual([{ path: 'assets/logo.png', reason: 'binary' }])
    expect(plan.chunks).toHaveLength(0)
  })
})

describe('planReviewMaterial — collapsed files', () => {
  it('excludes a collapsed file with reason "collapsed"', () => {
    const collapsed = diffFile({ oldPath: 'huge.sql', newPath: 'huge.sql', diff: '', collapsed: true })
    const other = diffFile({ oldPath: 'src/foo.ts', newPath: 'src/foo.ts' })
    const plan = asPlan(planReviewMaterial([collapsed, other], options()))

    expect(plan.excluded).toEqual([{ path: 'huge.sql', reason: 'collapsed' }])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0]!.files).toEqual([other])
  })
})

describe('planReviewMaterial — exclusion precedence', () => {
  it('a file that is BOTH generated and collapsed reports exactly one reason: the earlier rule (generated)', () => {
    const both = diffFile({
      oldPath: 'gen/big.sql',
      newPath: 'gen/big.sql',
      diff: '',
      collapsed: true,
      generatedFile: true,
    })
    const plan = asPlan(planReviewMaterial([both], options({ excludeGenerated: true })))

    expect(plan.excluded).toHaveLength(1)
    expect(plan.excluded[0]).toEqual({ path: 'gen/big.sql', reason: 'generated' })
  })

  it('a file that is BOTH exclude_path-matched and generated reports exclude_path (earliest of all)', () => {
    const both = diffFile({
      oldPath: 'vendor/gen.ts',
      newPath: 'vendor/gen.ts',
      generatedFile: true,
    })
    const plan = asPlan(
      planReviewMaterial([both], options({ excludePaths: ['vendor/**'], excludeGenerated: true })),
    )

    expect(plan.excluded).toEqual([{ path: 'vendor/gen.ts', reason: 'exclude_path' }])
  })

  it('a file that is BOTH binary and collapsed reports "binary" — checked before collapsed, though normally mutually exclusive', () => {
    // isCollapsedDiff would never actually flag a binary-marker diff as
    // collapsed (its own emptiness check rules that out), but the planner's
    // per-rule precedence should not depend on that invariant holding
    // upstream — it is asked for explicitly by the ORDER OF OPERATIONS.
    const weird = diffFile({
      oldPath: 'weird.bin',
      newPath: 'weird.bin',
      diff: 'Binary files a/weird.bin and b/weird.bin differ',
      collapsed: true,
    })
    const plan = asPlan(planReviewMaterial([weird], options()))
    expect(plan.excluded).toEqual([{ path: 'weird.bin', reason: 'binary' }])
  })
})

// ---------------------------------------------------------------------------
// chunking / packing
// ---------------------------------------------------------------------------

describe('planReviewMaterial — packing', () => {
  it('files summing to just under maxChunkBytes produce one chunk; one more file produces two', () => {
    const maxChunkBytes = 100
    const a = diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: 'X'.repeat(40) })
    const b = diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: 'Y'.repeat(40) })
    // 40 + 40 = 80 < 100: fits in one chunk.
    const oneChunkPlan = asPlan(planReviewMaterial([a, b], options({ maxChunkBytes })))
    expect(oneChunkPlan.chunks).toHaveLength(1)
    expect(oneChunkPlan.chunks[0]!.files).toEqual([a, b])

    const c = diffFile({ oldPath: 'c.ts', newPath: 'c.ts', diff: 'Z'.repeat(40) })
    // 40 + 40 + 40 = 120 > 100: must spill into a second chunk.
    const twoChunkPlan = asPlan(planReviewMaterial([a, b, c], options({ maxChunkBytes })))
    expect(twoChunkPlan.chunks).toHaveLength(2)

    // No file appears in two chunks and none is lost — the union of chunk
    // files equals the included set.
    const allFiles = twoChunkPlan.chunks.flatMap((chunk) => chunk.files)
    expect(allFiles).toHaveLength(3)
    expect(new Set(allFiles.map((f) => f.newPath))).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']))
    // Each file present exactly once across all chunks.
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      const count = twoChunkPlan.chunks.filter((chunk) => chunk.files.some((f) => f.newPath === path)).length
      expect(count).toBe(1)
    }
  })

  it('a single file larger than maxChunkBytes gets its own chunk and is NOT dropped', () => {
    const huge = diffFile({ oldPath: 'src/huge.ts', newPath: 'src/huge.ts', diff: 'X'.repeat(500) })
    const small = diffFile({ oldPath: 'src/small.ts', newPath: 'src/small.ts', diff: 'Y'.repeat(10) })
    const plan = asPlan(planReviewMaterial([huge, small], options({ maxChunkBytes: 100 })))

    // huge gets its own oversized chunk.
    const hugeChunk = plan.chunks.find((c) => c.files.some((f) => f.newPath === 'src/huge.ts'))
    expect(hugeChunk).toBeDefined()
    expect(hugeChunk!.files).toHaveLength(1)
    expect(hugeChunk!.diffBytes).toBe(500)
    expect(hugeChunk!.diffBytes).toBeGreaterThan(100)

    // small still shows up somewhere, not dropped.
    const allFiles = plan.chunks.flatMap((c) => c.files)
    expect(allFiles.map((f) => f.newPath)).toContain('src/small.ts')
    expect(allFiles).toHaveLength(2)
  })

  it('chunk indices are 0-based and contiguous', () => {
    const files = [
      diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: 'X'.repeat(60) }),
      diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: 'Y'.repeat(60) }),
      diffFile({ oldPath: 'c.ts', newPath: 'c.ts', diff: 'Z'.repeat(60) }),
    ]
    const plan = asPlan(planReviewMaterial(files, options({ maxChunkBytes: 100 })))
    expect(plan.chunks.map((c) => c.index)).toEqual(plan.chunks.map((_, i) => i))
  })

  it('never splits one file diff across two chunks (whole-file packing)', () => {
    const files = [
      diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: 'X'.repeat(70) }),
      diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: 'Y'.repeat(70) }),
    ]
    const plan = asPlan(planReviewMaterial(files, options({ maxChunkBytes: 100 })))
    // 70 + 70 = 140 > 100, so each lands in its own chunk, never split.
    expect(plan.chunks).toHaveLength(2)
    for (const chunk of plan.chunks) {
      expect(chunk.files).toHaveLength(1)
    }
  })

  it('groups files in the same directory into the same chunk where packing allows', () => {
    // Interleaved input: two directories, alternating. Directory grouping
    // should reorder packing so each directory's files land together,
    // provided their combined size still fits the budget.
    const files = [
      diffFile({ oldPath: 'dirA/1.ts', newPath: 'dirA/1.ts', diff: 'A'.repeat(20) }),
      diffFile({ oldPath: 'dirB/1.ts', newPath: 'dirB/1.ts', diff: 'B'.repeat(20) }),
      diffFile({ oldPath: 'dirA/2.ts', newPath: 'dirA/2.ts', diff: 'A'.repeat(20) }),
      diffFile({ oldPath: 'dirB/2.ts', newPath: 'dirB/2.ts', diff: 'B'.repeat(20) }),
    ]
    // Budget fits one directory's two files (40 bytes) but not three.
    const plan = asPlan(planReviewMaterial(files, options({ maxChunkBytes: 50 })))

    // Every dirA file shares a chunk, and every dirB file shares a (different) chunk.
    const chunkOfPath = (path: string) => plan.chunks.find((c) => c.files.some((f) => f.newPath === path))!.index
    expect(chunkOfPath('dirA/1.ts')).toBe(chunkOfPath('dirA/2.ts'))
    expect(chunkOfPath('dirB/1.ts')).toBe(chunkOfPath('dirB/2.ts'))

    // No file lost, none duplicated.
    const allFiles = plan.chunks.flatMap((c) => c.files)
    expect(allFiles).toHaveLength(4)
  })
})

describe('planReviewMaterial — too_many_chunks', () => {
  it('refuses when packing needs more chunks than maxChunks, and reports chunksRequired accurately', () => {
    const files = [
      diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: 'X'.repeat(60) }),
      diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: 'Y'.repeat(60) }),
      diffFile({ oldPath: 'c.ts', newPath: 'c.ts', diff: 'Z'.repeat(60) }),
    ]
    // Each file needs its own chunk (60 > half of 100 so no two pack together): 3 chunks required.
    const refusal = asRefusal(planReviewMaterial(files, options({ maxChunkBytes: 100, maxChunks: 2 })))

    expect(refusal.reason).toBe('too_many_chunks')
    expect(refusal.chunksRequired).toBe(3)
    expect(refusal.maxChunks).toBe(2)
    expect(refusal.filesConsidered).toBe(3)
  })
})

describe('planReviewMaterial — nothing_reviewable', () => {
  it('all files collapsed -> refusal nothing_reviewable', () => {
    const files = [
      diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: '', collapsed: true }),
      diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: '', collapsed: true }),
    ]
    const refusal = asRefusal(planReviewMaterial(files, options()))

    expect(refusal.reason).toBe('nothing_reviewable')
    expect(refusal.filesConsidered).toBe(2)
    expect(refusal.chunksRequired).toBe(0)
  })

  it('collapse of an excluded file does not trigger nothing_reviewable when a non-excluded file survives', () => {
    const files = [
      diffFile({ oldPath: 'vendor/big.js', newPath: 'vendor/big.js', diff: '', collapsed: true }),
      diffFile({ oldPath: 'src/foo.ts', newPath: 'src/foo.ts', diff: 'small' }),
    ]
    const plan = asPlan(planReviewMaterial(files, options({ excludePaths: ['vendor/**'] })))
    expect(plan.chunks).toHaveLength(1)
  })

  it('a mix of excluded and collapsed with nothing surviving still refuses as nothing_reviewable', () => {
    const files = [
      diffFile({ oldPath: 'vendor/x.js', newPath: 'vendor/x.js', diff: 'irrelevant' }),
      diffFile({ oldPath: 'huge.sql', newPath: 'huge.sql', diff: '', collapsed: true }),
    ]
    const refusal = asRefusal(planReviewMaterial(files, options({ excludePaths: ['vendor/**'] })))
    expect(refusal.reason).toBe('nothing_reviewable')
  })

  it('nothing survives but nothing was collapsed either (all exclude_path) -> a PLAN with zero chunks, not a refusal', () => {
    const files = [diffFile({ oldPath: 'vendor/x.js', newPath: 'vendor/x.js', diff: 'irrelevant' })]
    const plan = asPlan(planReviewMaterial(files, options({ excludePaths: ['vendor/**'] })))
    expect(plan.chunks).toHaveLength(0)
    expect(plan.excluded).toEqual([{ path: 'vendor/x.js', reason: 'exclude_path' }])
  })
})

describe('planReviewMaterial — zero input files', () => {
  it('is a PLAN with zero chunks, not a refusal — a merge request with no changes is real and reviewable', () => {
    const result = planReviewMaterial([], options())
    expect(result.kind).toBe('plan')
    const plan = asPlan(result)
    expect(plan.chunks).toEqual([])
    expect(plan.excluded).toEqual([])
    expect(plan.diffBytes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe('planReviewMaterial — determinism', () => {
  it('planning the same input twice produces identical chunk indices and identical file order', () => {
    const files = [
      diffFile({ oldPath: 'dirA/1.ts', newPath: 'dirA/1.ts', diff: 'A'.repeat(30) }),
      diffFile({ oldPath: 'dirB/1.ts', newPath: 'dirB/1.ts', diff: 'B'.repeat(30) }),
      diffFile({ oldPath: 'dirA/2.ts', newPath: 'dirA/2.ts', diff: 'A'.repeat(30) }),
      diffFile({ oldPath: 'huge.sql', newPath: 'huge.sql', diff: 'H'.repeat(500) }),
      diffFile({ oldPath: 'gen/schema.ts', newPath: 'gen/schema.ts', generatedFile: true }),
      diffFile({ oldPath: 'collapsed.sql', newPath: 'collapsed.sql', diff: '', collapsed: true }),
    ]
    const opts = options({ maxChunkBytes: 80, excludeGenerated: true })

    const first = planReviewMaterial(files, opts)
    const second = planReviewMaterial(files, opts)

    expect(second).toEqual(first)

    const p1 = asPlan(first)
    const p2 = asPlan(second)
    expect(p2.chunks.map((c) => c.index)).toEqual(p1.chunks.map((c) => c.index))
    expect(p2.chunks.map((c) => c.files.map((f) => f.newPath))).toEqual(
      p1.chunks.map((c) => c.files.map((f) => f.newPath)),
    )
  })

  it('does not mutate the input array', () => {
    const files = [
      diffFile({ oldPath: 'b.ts', newPath: 'b.ts' }),
      diffFile({ oldPath: 'a.ts', newPath: 'a.ts' }),
    ]
    const snapshot = [...files]
    planReviewMaterial(files, options())
    expect(files).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// diffBytes accounting on the plan as a whole
// ---------------------------------------------------------------------------

describe('planReviewMaterial — plan-level diffBytes', () => {
  it('sums only included files, matching the sum of each chunk\'s diffBytes', () => {
    const a = diffFile({ oldPath: 'a.ts', newPath: 'a.ts', diff: 'X'.repeat(30) })
    const b = diffFile({ oldPath: 'b.ts', newPath: 'b.ts', diff: 'Y'.repeat(30) })
    const excluded = diffFile({ oldPath: 'vendor/c.ts', newPath: 'vendor/c.ts', diff: 'Z'.repeat(9999) })
    const plan = asPlan(planReviewMaterial([a, b, excluded], options({ excludePaths: ['vendor/**'] })))

    const chunkSum = plan.chunks.reduce((sum, c) => sum + c.diffBytes, 0)
    expect(plan.diffBytes).toBe(chunkSum)
    expect(plan.diffBytes).toBe(60)
  })
})
