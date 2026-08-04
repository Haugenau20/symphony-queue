import { exec, spawn } from 'node:child_process'

export interface HookResult {
  success: boolean
  stdout: string
  stderr: string
  error: string | null
}

export function execHook(command: string, cwd: string, timeoutMs: number): Promise<HookResult> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

  if (process.platform === 'win32') {
    return winExecHook(command, cwd, timeoutMs, env)
  }

  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, env }, (err, stdout, stderr) => {
      if (err) {
        const isTimeout = (err.killed || err.message?.includes('timeout'))
        resolve({
          success: false, stdout, stderr,
          error: isTimeout ? `Hook timed out after ${timeoutMs}ms` : err.message,
        })
      } else {
        resolve({ success: true, stdout, stderr, error: null })
      }
    })
  })
}

function winExecHook(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<HookResult> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn('bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      resolve({ success: false, stdout, stderr, error: err.message })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (signal === 'SIGTERM' || code === null) {
        resolve({ success: false, stdout, stderr, error: `Hook timed out after ${timeoutMs}ms` })
      } else {
        resolve({ success: code === 0, stdout, stderr, error: code === 0 ? null : `Command exited with code ${code}` })
      }
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ success: false, stdout, stderr, error: `Hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('close', () => clearTimeout(timer))
  })
}
