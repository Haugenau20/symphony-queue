import type { Issue } from '../models.js'

export interface TrackerAdapter {
  fetchCandidateIssues(): Promise<Issue[]>
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>
  updateIssueState(issueId: string, stateName: string): Promise<void>

  /**
   * Optional. Leave a human-visible note on the item, for outcomes the state
   * alone cannot express — a run that exhausted its turns reaches exactly the
   * same state as one that finished, and a person triaging the board has no
   * way to tell them apart.
   *
   * Optional because it is only meaningful where the board is what people
   * read. On the GitLab tracker that is the issue, and a note is its natural
   * home. On the file queue the item file IS the record: it carries the state
   * in its directory and the counters in its front matter, and there is
   * nowhere a comment would be seen that the file is not.
   *
   * Never load-bearing. Callers must treat a missing implementation and a
   * failed call identically — as commentary that did not happen.
   */
  annotateIssue?(issueId: string, note: string): Promise<void>
}
