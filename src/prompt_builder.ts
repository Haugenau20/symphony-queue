import { Liquid } from 'liquidjs'
import type { Issue } from './models.js'

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
})

export function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
  extra?: Record<string, unknown>,
): string {
  const ctx: Record<string, unknown> = {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      description: issue.description,
      priority: issue.priority,
      branch_name: issue.branchName,
      url: issue.url,
      labels: issue.labels,
      blocked_by: issue.blockedBy.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        state: b.state,
      })),
      created_at: issue.createdAt?.toISOString() ?? null,
      updated_at: issue.updatedAt?.toISOString() ?? null,
    },
    attempt: attempt ?? null,
    ...extra,
  }

  return engine.parseAndRenderSync(template, ctx)
}
