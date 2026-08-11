#!/usr/bin/env bash
#
# Build the orchestrator image under the exact name Symphony-Launcher resolves.
#
#   ./scripts/build-image.sh                 # opencode-workplace-symphony:local
#   IMAGE_TAG=v3 ./scripts/build-image.sh    # opencode-workplace-symphony:v3
#   IMAGE_REGISTRY=registry.example.com/team/opencode-workplace \
#     IMAGE_TAG=2026-08-11 ./scripts/build-image.sh --push
#
# The name is not cosmetic: both docker-compose.symphony.yml and
# docker-compose.review.yml reference
# `${IMAGE_REGISTRY:-opencode-workplace}-symphony:${IMAGE_TAG:-local}`, and the
# launcher is pull-only — it will never build this for you, so a mismatched tag
# surfaces as "image not found" at `symphony up`, not at build time.
#
# Use the SAME IMAGE_REGISTRY and IMAGE_TAG values here as in the launcher's
# .env, or the launcher will look for an image this script did not produce.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

IMAGE_REGISTRY="${IMAGE_REGISTRY:-opencode-workplace}"
IMAGE_TAG="${IMAGE_TAG:-local}"
IMAGE="${IMAGE_REGISTRY}-symphony:${IMAGE_TAG}"

PUSH=0
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

echo "==> building ${IMAGE}"
docker build -t "${IMAGE}" ${EXTRA_ARGS+"${EXTRA_ARGS[@]}"} "$HERE"

echo "==> built ${IMAGE}"
docker image inspect "${IMAGE}" --format '    id      {{.Id}}
    size    {{.Size}} bytes
    created {{.Created}}'

if [ "$PUSH" -eq 1 ]; then
  case "$IMAGE_REGISTRY" in
    */*) ;;
    *)
      echo "error: --push needs a registry-qualified IMAGE_REGISTRY (e.g. registry.example.com/team/opencode-workplace)." >&2
      echo "       '${IMAGE_REGISTRY}' is a bare local name and cannot be pushed." >&2
      exit 1
      ;;
  esac
  echo "==> pushing ${IMAGE}"
  docker push "${IMAGE}"
fi

cat <<EOF

Next: point the launcher at it. In Symphony-Launcher/.env

    IMAGE_REGISTRY=${IMAGE_REGISTRY}
    IMAGE_TAG=${IMAGE_TAG}

then \`./symphony check <project>\` — it resolves the compose config and will
tell you if the name does not match what the stack expects.
EOF
