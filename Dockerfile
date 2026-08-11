# The orchestrator image the launcher runs.
#
# Symphony-Launcher is pull-only by contract (docs/IMAGE_CONTRACT.md): it never
# builds anything, it only assembles compose files and starts what a registry —
# or the local docker image store — already has. This Dockerfile is the other
# half of that interface: it produces
#
#     ${IMAGE_REGISTRY:-opencode-workplace}-symphony:${IMAGE_TAG:-local}
#
# which is the image name both docker-compose.symphony.yml and
# docker-compose.review.yml resolve to.
#
# It does NOT build the agent image (`${IMAGE_REGISTRY}:${IMAGE_TAG}`, used by
# the `opencode` and `opencode-review` services). That is a separate artifact
# with a separate build; this repository has no part in it.
#
# One image, two modes. The review controller and the issue orchestrator are
# the same binary — `SYMPHONY_MODE=review` selects which one starts, and the
# launcher fixes that variable in the `symphony-review` service block. That is
# deliberate: they share the agent runner, and shipping one image means the two
# pipelines can never drift to different builds of it.

# --- build ---------------------------------------------------------------------

FROM node:22-slim AS build

WORKDIR /app

# Deps first, so a source-only change does not re-resolve the tree. The lockfile
# is copied with package.json because `npm ci` requires both and fails loudly if
# they disagree — which is the behaviour we want in a build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The runtime needs production dependencies only. Pruning here rather than
# reinstalling in the runtime stage keeps the resolved tree identical to the one
# the build just type-checked against.
RUN npm prune --omit=dev

# --- runtime -------------------------------------------------------------------

FROM node:22-slim AS runtime

# tini reaps zombies and forwards signals. The orchestrator installs SIGINT and
# SIGTERM handlers to stop its poll loop and let in-flight work settle, so the
# signal actually has to arrive as a signal rather than being swallowed by PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/symphony-entrypoint

RUN chmod +x /usr/local/bin/symphony-entrypoint

# Runs as root by default, matching the rest of this stack: every persistent
# path is a host bind mount (/queue, /workspaces, /review-store,
# /review-workspaces) created by the launcher, and a fixed non-root UID inside
# the container would have to match whatever owns those directories on the host
# to be able to write to them. Override with `--user` (or compose's `user:`) if
# your host directories are owned by a known UID and you want the container to
# drop privileges — nothing in the orchestrator needs root.

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/symphony-entrypoint"]
