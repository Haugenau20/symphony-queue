/**
 * The shared contract for the merge-request review pipeline.
 *
 * This file is written once, before the parallel slices start, and is FROZEN
 * for their duration. Several slices are implemented concurrently against
 * these signatures: gitlab_mr.ts, store.ts and findings.ts implement them,
 * controller.ts, worker.ts and publisher.ts consume them. A signature that
 * changes underneath a concurrent slice is the one failure that cannot be
 * caught by either slice's own tests.
 *
 * So: if a signature here is wrong, report it rather than editing it. Changing
 * it is the orchestrator's call, made once, for everyone.
 *
 * Nothing in here is a tracker. Review deliberately does not go through
 * TrackerAdapter (src/tracker/base.ts) — it is a different resource, with a
 * different credential, and forcing it through an issue-shaped interface is
 * what this design exists to avoid.
 */

export interface ReviewJobKey {
  projectId: string          // full path, e.g. "my-org/service-a"
  mrIid: number
  headSha: string
}

export type ReviewJobState =
  | 'discovered' | 'claimed' | 'running' | 'publishing'
  | 'published' | 'superseded' | 'skipped' | 'failed'

export interface ReviewJob {
  key: ReviewJobKey
  baseSha: string
  startSha: string
  title: string
  webUrl: string | null
  state: ReviewJobState
  attempts: number
  nextRetryAt: Date | null
  discoveredAt: Date
  publishedNoteId: string | null
  skipReason: string | null
}

export interface ReviewStore {
  get(key: ReviewJobKey): Promise<ReviewJob | null>
  put(job: ReviewJob): Promise<void>
  update(job: ReviewJob): Promise<void>
  /** rename(2)-based claim. Resolves false if another process won. */
  claim(key: ReviewJobKey): Promise<boolean>
  /** discovered, plus failed whose nextRetryAt is due. */
  listClaimable(now: Date): Promise<ReviewJob[]>
  /** claimed/running at startup — the set that was live when we died. */
  recoverInFlight(): Promise<ReviewJob[]>
  readCursor(): Promise<Date | null>
  writeCursor(at: Date): Promise<void>
}

export interface MergeRequestSummary {
  projectId: string
  mrIid: number
  headSha: string
  baseSha: string
  startSha: string
  title: string
  description: string | null
  draft: boolean
  isFork: boolean
  state: string
  webUrl: string | null
  updatedAt: Date
}

export interface MergeRequestDiffFile {
  oldPath: string
  newPath: string
  diff: string
  newFile: boolean
  renamedFile: boolean
  deletedFile: boolean
  generatedFile: boolean
  /** Empty diff body on a file GitLab reports as changed. */
  collapsed: boolean
}

export interface MergeRequestClient {
  listOpenMergeRequests(opts: { updatedAfter: Date | null }): Promise<MergeRequestSummary[]>
  getMergeRequest(projectId: string, mrIid: number): Promise<MergeRequestSummary | null>
  listDiffs(projectId: string, mrIid: number): Promise<MergeRequestDiffFile[]>
  getFileAtRef(projectId: string, path: string, ref: string): Promise<string | null>
  listNotes(projectId: string, mrIid: number): Promise<Array<{ id: string; body: string }>>
  createNote(projectId: string, mrIid: number, body: string): Promise<string>
}

export interface Finding {
  severity: 'blocking' | 'concern' | 'nit'
  file: string
  line: number | null
  lineType: 'added' | 'removed' | 'context'
  title: string
  detail: string
  suggestion: string | null
}

export interface FindingsDocument {
  summary: string
  findings: Finding[]
}
