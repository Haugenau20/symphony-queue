import { describe, it, expect } from 'vitest'
import { execHook } from '../src/hooks.js'
import { tmpdir } from 'node:os'

const cwd = tmpdir()
const isWin = process.platform === 'win32'

describe('execHook', () => {
  it('executes a simple command and returns success', async () => {
    const cmd = isWin ? 'echo hello' : 'echo hello'
    const result = await execHook(cmd, cwd, 5000)
    expect(result.success).toBe(true)
  })

  it('fails on non-zero exit', async () => {
    const result = await execHook('exit 1', cwd, 5000)
    expect(result.success).toBe(false)
  })

  it('times out when command exceeds limit', async () => {
    const cmd = isWin ? 'sleep 10' : 'sleep 10'
    const result = await execHook(cmd, cwd, 100)
    expect(result.success).toBe(false)
    expect(result.error ?? '').toMatch(/timeout|timed out|Exit code/i)
  })
})
