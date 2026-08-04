import type { Issue } from '../models.js'
import type { TrackerAdapter } from './base.js'

export class MemoryTracker implements TrackerAdapter {
  private issues: Map<string, Issue> = new Map()

  constructor(private activeStates: string[] = ['Todo', 'In Progress']) {}

  addIssue(issue: Issue): void {
    this.issues.set(issue.id, issue)
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return Array.from(this.issues.values()).filter((i) =>
      this.activeStates.includes(i.state)
    )
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    return Array.from(this.issues.values()).filter((i) =>
      stateNames.includes(i.state)
    )
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return issueIds
      .map((id) => this.issues.get(id))
      .filter((i): i is Issue => i !== undefined)
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const issue = this.issues.get(issueId)
    if (!issue) throw new Error(`Issue ${issueId} not found`)
    this.issues.set(issueId, { ...issue, state: stateName })
  }
}
