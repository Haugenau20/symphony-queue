/**
 * Schema for FINDINGS.json — the review agent's only output surface (design
 * §10). Parsed with zod, same as file_queue's front matter, but with the
 * opposite posture on unknown keys.
 *
 * RULING (wave-2 review-core orchestrator addendum, ruling 1): unknown keys
 * are REJECTED via `.strict()`, not silently dropped. file_queue.ts drops
 * unknown front-matter keys because that front matter is periodically
 * rewritten by trusted code and a stray key is nothing more than clutter.
 * FINDINGS.json is different: it is the *entire* output surface of a
 * prompt-injected agent, so a schema that quietly strips fields it doesn't
 * recognize would let that agent smuggle a key through validation that a
 * later, less careful reader might trust. Failing loudly is the correct
 * default for this specific boundary. Do not relax this back to the
 * drop-unknown-keys posture "for consistency" — the inconsistency here is
 * intentional and documented, not an oversight.
 */

import { z } from 'zod'
import type { Finding, FindingsDocument } from './types.js'

const FindingSchema = z
  .object({
    severity: z.enum(['blocking', 'concern', 'nit']),
    file: z.string().min(1),
    line: z.number().int().nullable(),
    lineType: z.enum(['added', 'removed', 'context']),
    title: z.string().min(1),
    detail: z.string(),
    suggestion: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<Finding, z.ZodTypeDef, unknown>

const FindingsDocumentSchema = z
  .object({
    summary: z.string(),
    findings: z.array(FindingSchema),
  })
  .strict() satisfies z.ZodType<FindingsDocument, z.ZodTypeDef, unknown>

export type FindingsParseResult =
  | { success: true; data: FindingsDocument }
  | { success: false; error: string }

/** Throws on any validation failure — missing field, wrong type, or unknown key. */
export function parseFindingsDocument(input: unknown): FindingsDocument {
  return FindingsDocumentSchema.parse(input)
}

/**
 * Non-throwing form, for callers that want to record a specific failure
 * reason (e.g. "agent run failed: malformed findings") rather than catching
 * an exception. The error string never echoes the offending value, only the
 * path and the zod-generated reason, so a finding's `detail` text (which is
 * itself untrusted) cannot end up quoted back into a log line unexpectedly.
 */
export function safeParseFindingsDocument(input: unknown): FindingsParseResult {
  const result = FindingsDocumentSchema.safeParse(input)
  if (result.success) return { success: true, data: result.data }
  const error = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return { success: false, error }
}
