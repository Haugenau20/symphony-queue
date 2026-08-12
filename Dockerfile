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

# The private CA has to be trusted here too, not just at runtime: behind a
# TLS-intercepting corporate proxy it is `npm ci` that fails first, and the
# error ("unable to get local issuer certificate") does not obviously point at
# a missing root. See the note above the runtime stage's copy for why the whole
# directory is copied rather than a named file.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY ca/ /usr/local/share/ca-certificates/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# NOTE: deliberately no `ENV NODE_ENV=production` in this stage. It would make
# `npm ci` skip devDependencies, and TypeScript is a devDependency — the build
# would fail at `tsc`. NODE_ENV is set in the runtime stage, where it belongs.

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
#
# ca-certificates is installed explicitly rather than relied on from the base
# image, because `update-ca-certificates` below is what makes the optional
# private CA take effect.
#
# gosu drops privileges to `dev` in the entrypoint. That matters more than it
# looks: the agent container runs as uid 1000, and it has to WRITE into the same
# bind-mounted workspace this process creates. A root-owned 0755 directory is
# readable by the agent and not writable, which surfaces as the agent reading its
# material happily and then failing every write.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates gosu tini \
 && rm -rf /var/lib/apt/lists/*

# Optional private CA, for an internal GitLab or a TLS-intercepting proxy whose
# root neither Debian nor Node ships.
#
# The whole DIRECTORY is copied rather than a named file on purpose: `COPY
# ca/company-ca.crt ...` makes the build fail for anyone who does not have that
# exact file, which is most people. ca/ is committed containing only .gitkeep,
# so this is a no-op by default — update-ca-certificates does nothing when it
# finds no .crt — and drops in as many roots as you like when you need them.
COPY ca/ /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Node ships its own CA bundle and ignores the system store, so a certificate
# that curl accepts inside this container would still fail here. Pointed at the
# bundle update-ca-certificates just rebuilt rather than at one named file: that
# is public roots PLUS every private root in ca/, so it keeps working with more
# than one CA and does not break if ca/ is empty.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/symphony-entrypoint

RUN chmod +x /usr/local/bin/symphony-entrypoint

# A `dev` user at uid 1000, matching the agent image's own user. The entrypoint
# remaps it to HOST_UID/HOST_GID when those are set (the launcher always sets
# them) and then executes as that user via gosu.
#
# Starting as root is deliberate and temporary: the entrypoint needs root to
# usermod and to chown the bind-mounted volumes, and drops privileges before the
# orchestrator itself ever runs. Nothing in the orchestrator needs root.
#
# node:22-slim already ships a `node` user AT uid 1000, so `useradd -u 1000`
# fails with "UID 1000 is not unique". Rename that user rather than fight it:
# the uid is what has to match the agent container, and the name is internal to
# this image's entrypoint. The else branch keeps this working on a base image
# that has no such user (the agent image builds from debian:bookworm-slim, where
# 1000 is free).
RUN if id -u node >/dev/null 2>&1; then \
      usermod -l dev -d /home/dev -m node \
      && groupmod -n dev node; \
    else \
      groupadd -g 1000 dev \
      && useradd -m -u 1000 -g 1000 -s /bin/bash dev; \
    fi \
 && id dev

# gosu preserves the environment, so without this HOME would still be /root
# after dropping privileges — and anything that writes a cache under ~ would
# fail on a directory it cannot touch. Nothing here does today; this is one line
# against a class of confusing failure rather than a fix for a known one.
ENV HOME=/home/dev

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/symphony-entrypoint"]
