import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Agent } from 'undici'
import {
  asFetchDispatcher,
  createAgentDispatcher,
  makeOpencodeClientFactory,
} from '../src/opencode_client.js'

/**
 * A turn is one HTTP request held open for as long as the agent works, so the
 * dispatcher behind the OpenCode client must impose no deadline of its own.
 * undici's default `headersTimeout` is 300s, which silently capped every turn
 * at five minutes and surfaced as `TypeError: fetch failed` — indistinguishable
 * from the server being down, and immune to `session_timeout_ms`.
 *
 * These use a server that stalls before sending headers, and a deliberately
 * small timeout standing in for the 300s one. Proving the real default would
 * mean waiting five minutes; proving the mechanism takes two seconds.
 *
 * Note undici's timer granularity: a 200ms headersTimeout actually fires at
 * ~1000ms, so REPLY_DELAY_MS has to clear that, not just clear 200.
 */
const REPLY_DELAY_MS = 2000
const IMPATIENT_MS = 200

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

/** Listens, then waits before sending headers — the shape of a slow turn. */
async function stallingServer(delayMs: number): Promise<string> {
  server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    }, delayMs).unref()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const addr = server!.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  return `http://127.0.0.1:${addr.port}`
}

function fetchVia(url: string, dispatcher: Agent): Promise<Response> {
  return fetch(url, { dispatcher: asFetchDispatcher(dispatcher) })
}

function undiciCode(err: unknown): string | undefined {
  let code: string | undefined
  for (let c = err as { code?: string, cause?: unknown } | undefined; c; c = c.cause as typeof c) {
    if (c.code) code = c.code
  }
  return code
}

describe('opencode client dispatcher', () => {
  it('a headers timeout shorter than the turn collapses into "fetch failed"', async () => {
    // The bug being fixed. Without this the passing test below would prove
    // only that the stalling server eventually replies.
    const url = await stallingServer(REPLY_DELAY_MS)
    const impatient = new Agent({ headersTimeout: IMPATIENT_MS, bodyTimeout: IMPATIENT_MS })
    try {
      await expect(fetchVia(url, impatient)).rejects.toThrow(/fetch failed/)

      const code = await fetchVia(url, impatient).then(() => undefined, undiciCode)
      expect(code).toBe('UND_ERR_HEADERS_TIMEOUT')
    } finally {
      await impatient.close()
    }
  })

  it('the shipped dispatcher waits however long the turn takes', async () => {
    const url = await stallingServer(REPLY_DELAY_MS)
    const dispatcher = createAgentDispatcher()
    try {
      const res = await fetchVia(url, dispatcher)
      expect(res.status).toBe(200)
    } finally {
      await dispatcher.close()
    }
  })

  it('arms no header or body timer at all', async () => {
    // Zero is undici's "do not set the timer", not "expire immediately" — the
    // distinction the whole fix rests on.
    const dispatcher = createAgentDispatcher()
    try {
      const opts = Object.getOwnPropertySymbols(dispatcher)
        .map((s) => (dispatcher as unknown as Record<symbol, unknown>)[s])
        .find((v): v is { headersTimeout: number, bodyTimeout: number } =>
          !!v && typeof v === 'object' && 'headersTimeout' in v)
      expect(opts?.headersTimeout).toBe(0)
      expect(opts?.bodyTimeout).toBe(0)
    } finally {
      await dispatcher.close()
    }
  })

  it('the client actually routes through the dispatcher it was given', async () => {
    // If the SDK were ever left on an unconfigured globalThis.fetch, the 300s
    // default would come back silently and nothing else here would notice.
    // Handing the factory an impatient dispatcher and requiring the call to
    // die by ITS deadline is what makes that observable.
    const url = await stallingServer(REPLY_DELAY_MS)
    const impatient = new Agent({ headersTimeout: IMPATIENT_MS, bodyTimeout: IMPATIENT_MS })
    try {
      const client = makeOpencodeClientFactory(url, impatient)(null)
      const started = Date.now()
      const result = await client.session.list()

      // The SDK returns transport failures rather than throwing them.
      expect(result.error).toBeDefined()
      expect(undiciCode(result.error)).toBe('UND_ERR_HEADERS_TIMEOUT')
      expect(Date.now() - started).toBeLessThan(REPLY_DELAY_MS)
    } finally {
      await impatient.close()
    }
  })

  it('passes the request through intact, signal included', async () => {
    // The pass-through exists so `signal` survives without being copied by
    // hand: it carries session_timeout_ms and the orchestrator's cancellation.
    const url = await stallingServer(REPLY_DELAY_MS)
    const dispatcher = createAgentDispatcher()
    try {
      const client = makeOpencodeClientFactory(url, dispatcher)(null)
      const result = await client.session.list({}, { signal: AbortSignal.timeout(300) })

      expect(result.error).toBeDefined()
      expect(String(result.error)).toMatch(/abort|timeout/i)
    } finally {
      await dispatcher.close()
    }
  })
})
