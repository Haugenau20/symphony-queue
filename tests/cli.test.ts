import { describe, it, expect } from 'vitest'
import { parseCliArgs, guardrailsBanner, usageMessage } from '../src/cli.js'

describe('parseCliArgs', () => {
  it('defaults when no args provided', () => {
    const args = parseCliArgs([])
    expect(args.command).toBe('start')
    expect(args.workflowPath).toBeNull()
    expect(args.logsRoot).toBeNull()
    expect(args.acknowledged).toBe(false)
  })

  it('parses a bare workflow path', () => {
    const args = parseCliArgs(['./my/WORKFLOW.md'])
    expect(args.command).toBe('start')
    expect(args.workflowPath).toBe('./my/WORKFLOW.md')
  })

  it('parses an explicit start subcommand', () => {
    const args = parseCliArgs(['start', './my/WORKFLOW.md'])
    expect(args.command).toBe('start')
    expect(args.workflowPath).toBe('./my/WORKFLOW.md')
  })

  it('parses --logs-root flag', () => {
    const args = parseCliArgs(['--logs-root', '/var/log/symphony'])
    expect(args.logsRoot).toBe('/var/log/symphony')
  })

  it('parses the acknowledgement flag', () => {
    const args = parseCliArgs(['--i-understand-that-this-will-be-running-without-the-usual-guardrails'])
    expect(args.acknowledged).toBe(true)
  })

  it('combines all flags', () => {
    const args = parseCliArgs([
      '--logs-root', './logs',
      'start',
      'path/to/WORKFLOW.md',
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails',
    ])
    expect(args.logsRoot).toBe('./logs')
    expect(args.workflowPath).toBe('path/to/WORKFLOW.md')
    expect(args.acknowledged).toBe(true)
    expect(args.command).toBe('start')
  })

  it('reports unknown flags instead of guessing at their values', () => {
    const args = parseCliArgs(['--port', '8080', './WORKFLOW.md'])
    expect(args.unknownFlags).toEqual(['--port'])
    // '8080' is still a positional, which is exactly why we refuse to start:
    // silently treating it as the workflow path would fail confusingly later.
    expect(args.workflowPath).toBe('8080')
  })

  it('has no unknown flags for a well-formed invocation', () => {
    const args = parseCliArgs(['start', './WORKFLOW.md', '--logs-root', './logs'])
    expect(args.unknownFlags).toEqual([])
  })

  it('does not consume --logs-root when its value is missing', () => {
    const args = parseCliArgs(['--logs-root'])
    expect(args.logsRoot).toBeNull()
    expect(args.workflowPath).toBeNull()
    expect(args.unknownFlags).toEqual(['--logs-root'])
  })
})

describe('guardrailsBanner', () => {
  it('names the acknowledgement flag and describes the risk', () => {
    const banner = guardrailsBanner()
    expect(banner).toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails')
    expect(banner).toContain('isolated harness')
  })
})

describe('usageMessage', () => {
  it('documents only the start command', () => {
    const usage = usageMessage()
    expect(usage).toContain('start')
    expect(usage).not.toContain('--port')
    expect(usage).not.toMatch(/\bstop\b/)
  })
})
