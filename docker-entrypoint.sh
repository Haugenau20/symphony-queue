#!/bin/sh
# Entrypoint for the orchestrator image.
#
# Four jobs, all of which exist because of how the launcher starts this stack:
#
#   1. Match the container user to the host. The launcher passes HOST_UID and
#      HOST_GID; the agent container's own user is remapped the same way. Both
#      halves have to agree, because they share a bind mount.
#
#   2. Fix ownership on the bind-mounted volumes. THIS IS NOT COSMETIC. The
#      agent, in a different container running as that uid, has to WRITE into the
#      workspace this process creates — FINDINGS.json for a review, a git clone
#      for an implementation run. A root-owned 0755 directory is readable and not
#      writable, which surfaces as an agent that reads its material happily and
#      then fails every single write. That cost a day to find.
#
#   3. Wait for the OpenCode server. Compose starts services in parallel, so the
#      agent server is routinely not listening yet when this container's first
#      request would go out.
#
#   4. Turn the environment contract into argv, then drop privileges. The
#      launcher communicates through environment variables
#      (docs/IMAGE_CONTRACT.md); the binary takes a config path as a positional
#      argument. This is where the two meet.
#
# Anything passed to `docker run`/`command:` is appended, so a one-off override
# still works.

set -eu

log() { printf 'symphony: %s\n' "$*" >&2; }

HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"

# --- 1. align the container user with the host --------------------------------

if [ "$(id -u)" = "0" ]; then
  usermod  -u "${HOST_UID}" dev 2>/dev/null || true
  groupmod -g "${HOST_GID}" dev 2>/dev/null || true
fi

# --- 2. make the shared volumes writable by that user ------------------------
#
# Only the paths this mode actually uses, and only when running as root. Failure
# is tolerated: a read-only mount (/config) is legitimate, and a chown that
# cannot succeed should not stop the run.

chown_if_present() {
  [ -n "${1:-}" ] || return 0
  [ -d "$1" ] || return 0
  chown -R "${HOST_UID}:${HOST_GID}" "$1" 2>/dev/null || log "could not chown $1 (continuing)"
}

if [ "${SYMPHONY_MODE:-}" = "review" ]; then
  REVIEW_STORE="${SYMPHONY_REVIEW_STORE_ROOT:-/review-store}"
  REVIEW_WORKSPACES="${SYMPHONY_REVIEW_WORKSPACES_ROOT:-/review-workspaces}"
  mkdir -p "${REVIEW_STORE}" "${REVIEW_WORKSPACES}" 2>/dev/null || true
  if [ "$(id -u)" = "0" ]; then
    chown_if_present "${REVIEW_STORE}"
    chown_if_present "${REVIEW_WORKSPACES}"
  fi
else
  QUEUE_ROOT="${SYMPHONY_QUEUE_ROOT:-/queue}"
  WORKSPACES_ROOT="${SYMPHONY_WORKSPACES_ROOT:-/workspaces}"
  mkdir -p "${WORKSPACES_ROOT}" 2>/dev/null || true
  if [ "$(id -u)" = "0" ]; then
    chown_if_present "${QUEUE_ROOT}"
    chown_if_present "${WORKSPACES_ROOT}"
  fi
fi

# --- 3. wait for the agent server --------------------------------------------

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
  log "opencode at ${url} did not become ready; starting anyway"
  return 0
}

wait_for_opencode

# --- 4. run as the unprivileged user -----------------------------------------

# gosu only when we are actually root; the image can also be started with
# `--user`, in which case there is nothing to drop and nothing to remap.
run() {
  if [ "$(id -u)" = "0" ]; then
    exec gosu dev "$@"
  fi
  exec "$@"
}

if [ "${SYMPHONY_MODE:-}" = "review" ]; then
  # The review agent denies bash and webfetch, holds no credential and has no
  # egress; the one thing it writes is FINDINGS.json, inside a sandbox that is
  # destroyed after every job. The guardrails acknowledgement is about an agent
  # that has all of that granted, so it does not apply to this mode.
  run node dist/main.js "${SYMPHONY_REVIEW_WORKFLOW:-/config/REVIEW.md}" "$@"
fi

run node dist/main.js "${SYMPHONY_WORKFLOW:-/config/WORKFLOW.md}" \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails "$@"
