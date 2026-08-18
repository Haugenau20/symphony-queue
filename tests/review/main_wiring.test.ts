import { describe, it, expect } from 'vitest'
import { buildReviewPublisher } from '../../src/main.js'
import type { DiscussionPosition, FindingsDocument, MergeRequestClient, MergeRequestDiffFile, MergeRequestDiscussionClient, ReviewJob } from '../../src/review/types.js'

/**
 * The deployment seam. Everything else in this phase is covered by tests that
 * construct their own publisher, which means they all pass whether or not
 * main.ts actually turns the feature on. Deleting the flag from main.ts's
 * publisher construction makes inline discussions impossible in production,
 * and before this file existed that left the whole suite green.
 *
 * Same shape as the two other bugs this phase produced: correct code, correct
 * tests, and one unexercised wire between them.
 */

const job: ReviewJob = {
  key: { projectId: 'grp/svc', mrIid: 1, headSha: 'head1' },
  baseSha: 'base1', startSha: 'start1', title: 't', webUrl: null,
  state: 'claimed', attempts: 0, nextRetryAt: null,
  discoveredAt: new Date('2026-01-01T00:00:00Z'),
  publishedNoteId: null, skipReason: null,
}

const diffFiles: MergeRequestDiffFile[] = [{
  oldPath: 'a.ts', newPath: 'a.ts',
  diff: '@@ -1,1 +1,2 @@\n context\n+added line\n',
  newFile: false, renamedFile: false, deletedFile: false, generatedFile: false, collapsed: false,
}]

const findings: FindingsDocument = {
  summary: 's',
  findings: [{
    severity: 'blocking', file: 'a.ts', line: 2, lineType: 'added',
    title: 'a real finding', detail: 'd', suggestion: null,
  }],
}

function fakeClient() {
  const created: DiscussionPosition[] = []
  const client: MergeRequestClient & MergeRequestDiscussionClient = {
    listOpenMergeRequests: async () => [],
    getMergeRequest: async () => ({
      projectId: 'grp/svc', mrIid: 1, headSha: 'head1', baseSha: 'base1', startSha: 'start1',
      title: 't', description: null, draft: false, isFork: false, state: 'opened',
      webUrl: null, updatedAt: new Date('2026-01-01T00:00:00Z'),
    }),
    listDiffs: async () => [],
    getFileAtRef: async () => null,
    listNotes: async () => [],
    createNote: async () => 'note-1',
    getCurrentUserId: async () => 'self',
    listDiscussions: async () => [],
    createDiscussion: async (_p, _i, _b, position) => { created.push(position); return 'disc-1' },
    replyToDiscussion: async () => 'r1',
    resolveDiscussion: async () => true,
  }
  return { client, created }
}

describe('main.ts wiring — the flag actually reaches the publisher', () => {
  it('inlineComments true produces a real inline discussion', async () => {
    const { client, created } = fakeClient()
    const result = await buildReviewPublisher(client, { inlineComments: true })
      .publish({ job, findings, diffFiles })

    expect(result.status).toBe('published')
    // The assertion that fails when main.ts stops passing the flag.
    expect(created).toHaveLength(1)
    expect(created[0]!.newLine).toBe(2)
  })

  it('inlineComments false posts no discussion at all', async () => {
    const { client, created } = fakeClient()
    const result = await buildReviewPublisher(client, { inlineComments: false })
      .publish({ job, findings, diffFiles })

    expect(result.status).toBe('published')
    expect(created).toHaveLength(0)
  })
})
