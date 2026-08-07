import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { Agent } from 'undici'

/**
 * `session.prompt` holds ONE HTTP request open for an entire turn: the response
 * headers do not arrive until the agent has finished thinking, called every
 * tool and run every command. undici's default `headersTimeout` is 300s, so any
 * turn whose total wall clock passed five minutes died with an opaque
 * `TypeError: fetch failed` at ~300000ms — while `session_timeout_ms` sat at its
 * 3600000 default, never reached.
 *
 * Slow models make this routine, and the tell is misleading: no single response
 * takes five minutes, the TURN does. Twenty round-trips at fifteen seconds is
 * already over the line.
 *
 * Disabled rather than raised. Symphony already bounds each prompt with an
 * AbortSignal built from `session_timeout_ms` (see `AgentRunner.promptSignal`):
 * that bound is configurable and fails legibly. A second, invisible,
 * non-configurable one underneath it was the bug — and another number to keep
 * in sync with it would be the next one. Zero is special-cased by undici to
 * skip arming the timer at all, rather than meaning "expire immediately".
 */
const NO_TIMEOUT = 0

/**
 * Scoped to the OpenCode client rather than installed with
 * `setGlobalDispatcher`, for the same reason `GitLabTracker` scopes its
 * `ProxyAgent`: symphony's two HTTP conversations have opposite needs — one
 * long-lived and direct, one short and proxied — and a global dispatcher forces
 * whichever is configured second to wear the other's settings.
 */
export function createAgentDispatcher(): Agent {
  return new Agent({ headersTimeout: NO_TIMEOUT, bodyTimeout: NO_TIMEOUT })
}

export type OpencodeClientFactory = (directory: string | null) => OpencodeClient

/**
 * A dispatcher is one runtime object described by two declaration files: the
 * npm `undici` package (which provides the `Agent` constructor) and the
 * `undici-types` that `@types/node` uses to type `RequestInit.dispatcher`.
 * They are structurally incompatible on paper and identical in practice, so
 * the cast is confined to this one value rather than smeared over the init
 * object — and `tests/opencode_client.test.ts` proves the runtime end works.
 */
export function asFetchDispatcher(dispatcher: Agent): RequestInit['dispatcher'] {
  return dispatcher as unknown as RequestInit['dispatcher']
}

/**
 * One client per workspace, not one for all sessions: `directory` is
 * client-level config in the SDK, and each item has its own workspace. A shared
 * client roots every session at the server default — `/` on a fresh OpenCode
 * server — which is not where any of the work is. Clients are thin wrappers
 * over fetch, so building one per dispatch costs nothing. The dispatcher is
 * built once and shared, so they also share a connection pool.
 */
export function makeOpencodeClientFactory(
  serverUrl: string,
  dispatcher: Agent = createAgentDispatcher(),
): OpencodeClientFactory {
  // The SDK hands us a fully-built Request and we pass it through untouched,
  // adding only the dispatcher. Rebuilding it as (url, init) for undici's own
  // `fetch` would work too, but every field then has to be copied by hand —
  // and `signal` is one of them. That signal is what carries
  // session_timeout_ms and the orchestrator's cancellation, so forwarding it
  // structurally beats remembering to.
  const fetchVia: typeof fetch = (input, init) =>
    fetch(input, { ...init, dispatcher: asFetchDispatcher(dispatcher) })

  return (directory: string | null) => createOpencodeClient({
    baseUrl: serverUrl,
    fetch: fetchVia,
    ...(directory ? { directory } : {}),
  })
}
