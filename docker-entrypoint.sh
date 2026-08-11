#!/bin/sh
# Entrypoint for the orchestrator image.
#
# Two jobs, both of which exist because of how the launcher starts this stack:
#
#   1. Wait for the OpenCode server. Compose starts services in parallel, so the
#      agent server is routinely not listening yet when this container's first
#      request would go out. The orchestrator survives that on its own (it warns
#      and proceeds), but waiting here turns a confusing first-run warning into
#      a boring startup delay.
#
#   2. Turn the environment contract into argv. The launcher communicates
#      through environment variables (docs/IMAGE_CONTRACT.md); the binary takes
#      a config path as a positional argument. This is where the two meet.
#
# Anything passed to `docker run`/`command:` is appended, so a one-off override
# still works.

set -eu

wait_for_opencode() {
  url="${SYMPHONY_OPENCODE_URL:-}"
  [ -n "$url" ] || return 0

  # node rather than curl: Node 22 has a global fetch, and this keeps the
  # runtime image free of a tool that exists solely for one startup probe.
  node -e '
    const base = process.argv[1]
    const tries = Number(process.argv[2] || 60)
    ;(async () => {
      for (let i = 0; i < tries; i++) {
        try {
          const res = await fetch(base + "/global/health", { signal: AbortSignal.timeout(3000) })
          if (res.ok) process.exit(0)
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 2000))
      }
      process.exit(1)
    })()
  ' "$url" "${SYMPHONY_OPENCODE_WAIT_TRIES:-60}" && return 0

  # Not fatal. The orchestrator logs its own health-check warning and proceeds;
  # the first session request is the real confirmation either way.
  echo "symphony-entrypoint: opencode at ${url} did not become ready; starting anyway" >&2
  return 0
}

wait_for_opencode

if [ "${SYMPHONY_MODE:-}" = "review" ]; then
  # The review agent denies bash, webfetch and external_directory, holds no
  # credential and has no egress; the one thing it can write is FINDINGS.json
  # inside a sandbox that is destroyed after every job. The guardrails
  # acknowledgement is about an agent that has all four granted, so it does not
  # apply to this mode.
  exec node dist/main.js "${SYMPHONY_REVIEW_WORKFLOW:-/config/REVIEW.md}" "$@"
fi

exec node dist/main.js "${SYMPHONY_WORKFLOW:-/config/WORKFLOW.md}" \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails "$@"
