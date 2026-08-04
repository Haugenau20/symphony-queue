import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import type { WorkflowDefinition } from './models.js'

export function loadWorkflow(path: string | null): WorkflowDefinition {
  const resolvedPath = path ? resolve(path) : join(process.cwd(), 'WORKFLOW.md')

  if (!existsSync(resolvedPath)) {
    throw new Error(`Workflow file not found: ${resolvedPath}`)
  }

  const raw = readFileSync(resolvedPath, 'utf-8')
  const { config, promptBody } = splitFrontMatter(raw)

  const validatedConfig = config !== null ? config : {}
  if (validatedConfig !== null && (typeof validatedConfig !== 'object' || Array.isArray(validatedConfig))) {
    throw new Error('YAML front matter must decode to a map/object')
  }

  return {
    config: validatedConfig as Record<string, unknown>,
    promptTemplate: promptBody.trim(),
  }
}

function splitFrontMatter(raw: string): { config: unknown; promptBody: string } {
  if (!raw.startsWith('---')) {
    return { config: null, promptBody: raw }
  }

  const rest = raw.slice(3)
  const endIdx = rest.indexOf('\n---')
  if (endIdx === -1) {
    return { config: null, promptBody: raw }
  }

  const yamlText = rest.slice(0, endIdx)
  const body = rest.slice(endIdx + 4)

  const config = yamlLoad(yamlText)
  return { config, promptBody: body }
}
