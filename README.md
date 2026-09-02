# symphony-queue

An implementation of [Symphony](https://github.com/openai/symphony) that turns tracked work
items into isolated, autonomous coding-agent runs. It deliberately uses
[OpenCode](https://opencode.ai) rather than Codex, and supports two tracker backends:

- **A directory tree on disk.** No service or token is required; the folder containing a
  markdown file is its state.
- **GitLab Issues.** Workflow state is represented by namespaced labels, while the GitLab
  token comes from the environment rather than the workflow file.

It is a library plus a service: a poll loop reads the selected tracker, dispatches an agent
per eligible item into its own workspace, and drives the item through a state machine until a
human accepts it.

## The file-queue model

```
<queue-root>/
├── todo/          in-progress/    review/
└── done/          failed/         cancelled/
```

One markdown file per work item, `<id>-<slug>.md`, with YAML front matter and a free-text
body. The parent directory *is* the item's state:

| Directory | `Issue.state` | Dispatchable? | Terminal? |
|---|---|---|---|
| `todo/` | `Todo` | yes | no |
| `in-progress/` | `In Progress` | yes (resume) | no |
| `review/` | `In Review` | **no** — human gate | no |
| `done/` | `Done` | no | yes |
| `failed/` | `Failed` | no — via retry sweep | no |
| `cancelled/` | `Cancelled` | no | yes |

Three properties fall out of this, and they are the whole point:

- **`ls` tells you the state.** No dashboard, no database, no query language. That is why
  this repo ships no terminal UI and no HTTP status server.
- **State transitions use `rename(2)`.** Moving `todo/X.md` → `in-progress/X.md` is atomic
  within a filesystem, so readers never observe a half-transition. The scheduler is still a
  single-process service: run only one orchestrator against a queue root.
- **Crash recovery is free.** Whatever is sitting in `in-progress/` when the process starts is
  exactly the recovery set (SPEC §14.3).

Front matter must **not** carry a `state:` field — the directory is the single source of
truth, and a `state:` key found in a file is ignored with a warning. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full rules, including how queue files are treated
as untrusted input.

## The GitLab model

GitLab Issues use one label under a configurable namespace for workflow state. With the
default `symphony` prefix, the labels are `symphony::todo`, `symphony::in-progress`,
`symphony::review`, `symphony::done`, `symphony::failed` and `symphony::cancelled`.
Transitions replace the complete set of Symphony state labels in one API request while
preserving unrelated labels.

GitLab does not provide the filesystem's atomic rename operation. As with the file queue, only
one orchestrator should poll a given tracker. Failed GitLab items also require a human to
relabel them; the automatic retry sweep is currently specific to the file queue.

## Provenance

- **The durable artifact is upstream's `SPEC.md`** — `openai/symphony` @
  `f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7`. The state machine (§7), retry/backoff (§8.4),
  filesystem safety invariants (§9.5), restart recovery (§14.3) and hook safety (§15.4) are
  followed here.
- **The TypeScript skeleton was seeded from** `striderZA/symphony` @
  `5010873aa139927399e9e0e215b56698b985b0c8`, which ported Symphony to OpenCode. The
  orchestrator, agent runner, workspace manager, config/workflow loading, prompt builder and
  logging come from there, then stripped and renamed.

Both are Apache-2.0; so is this. `LICENSE` is upstream's, and `NOTICE` carries upstream's
copyright, the attribution to the OpenCode port at its pinned SHA, and my own line.

## This is not a fork

Deliberately. It was built fresh, with files copied by hand and attributed, rather than
forked:

- The OpenCode port is **not an ancestor of upstream** — the two have genuinely diverged.
- Upstream churns hard. Between the two pinned commits it **deleted its entire `python/`
  reference implementation** and changed `SPEC.md` by 550 lines.
- The `typescript/` tree worth reusing is the port's own addition. It does not exist upstream,
  so there is no upstream branch to track for it.
- Every change made here — the file queue, the locked-down credential model — exists because
  of a restricted execution environment, which is the opposite of Symphony's design intent.
  None of it would ever be upstreamed.

So: the SPEC is a durable reference, the code in both repos is disposable reference, and
inheriting either git history would buy nothing.

## Configuration

Runtime config is the YAML front matter of a `WORKFLOW.md`; its body is the Liquid prompt
template. The real one belongs to the consuming project, not here.

```yaml
---
tracker:
  kind: file_queue
  root: ./queue          # the six state directories live directly under this
  max_attempts: 5        # attempts beyond this stay in failed/ forever
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
polling:
  interval_ms: 30000
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: 4
  max_turns: 20
  completion_marker: SYMPHONY_DONE
opencode:
  server_url: http://localhost:4096
---

Work on {{ issue.identifier }}: {{ issue.title }}.
When the work is complete, end your reply with SYMPHONY_DONE on a line of its own.
```

For GitLab, replace the tracker block with:

```yaml
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/project
  label_prefix: symphony
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
```

Set `SYMPHONY_GITLAB_TOKEN` in the process environment. There is deliberately no token or
generic environment-variable resolver in the workflow schema, so credentials cannot be read
from `WORKFLOW.md`.

### Merge-request review profiles

Review mode reads YAML front matter and a shared prompt from `REVIEW.md`. Named reviewers add
small, trusted specializations to that shared prompt and run independently over every material
batch. Exactly one reviewer is primary and always runs; supplemental reviewers may opt out of
large reviews with `max_chunks`.

```yaml
---
review:
  base_url: https://gitlab.example.com
  group_id: my-group
  max_concurrent_reviews: 3
  max_parallel_review_agents: 6
  reviewers:
    - id: general
      primary: true
      instructions: Review the change broadly for correctness and maintainability.
    - id: security
      max_chunks: 2
      instructions: Focus on trust boundaries, authorization, secrets, and unsafe input.
    - id: reliability
      max_chunks: 2
      instructions: Focus on failure recovery, retries, concurrency, and data loss.
agent:
  max_turns: 10
  completion_marker: SYMPHONY_REVIEW_DONE
---

Review the supplied merge-request material. Write the required FINDINGS.json and finish with
SYMPHONY_REVIEW_DONE.
```

`max_parallel_review_agents` is one process-wide ceiling shared by reviewer and critic
sessions across all active merge requests; it defaults to `max_concurrent_reviews`. Work is
scheduled fairly across merge requests. Omitting `reviewers` preserves the previous single
broad reviewer. The review token and durable/workspace roots remain environment-only:
`SYMPHONY_REVIEW_GITLAB_TOKEN`, `SYMPHONY_REVIEW_STORE_ROOT`, and
`SYMPHONY_REVIEW_WORKSPACES_ROOT`.

Workspace hooks are optional trusted shell commands:

```yaml
hooks:
  after_create: null  # once, after a workspace is first created
  before_run: null    # before each agent run
  after_run: null     # after every attempted agent run, including failures
  before_remove: null # before a terminal workspace is removed
  timeout_ms: 60000
```

```bash
node dist/main.js ./WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

## Requirements

- Node 22+ and npm. No Bun, no Deno.
- An OpenCode server to talk to (not needed for the test suite).

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Building the deployment image

Symphony-Launcher is pull-only by contract — it assembles compose files and
starts what the image store already has, and it will never build this for you.
This repository is the other half of that interface:

```bash
npm run image:build            # opencode-symphony:local
```

or, for a real registry:

```bash
IMAGE_REGISTRY=registry.example.com/team/opencode \
IMAGE_TAG=2026-08-11 \
  ./scripts/build-image.sh --push
```

The name matters. Both `docker-compose.symphony.yml` and
`docker-compose.review.yml` resolve
`${IMAGE_REGISTRY:-opencode}-symphony:${IMAGE_TAG:-local}`, so use
the same two values here as in the launcher's `.env` or `symphony up` will
look for an image this build did not produce.

One image, two modes: `SYMPHONY_MODE=review` starts the merge-request review
controller instead of the issue orchestrator. They share the agent runner, so
shipping one image is what stops the two pipelines drifting to different builds
of it.

This does **not** build the agent image (`${IMAGE_REGISTRY}:${IMAGE_TAG}`, run
by the `opencode` and `opencode-review` services). That is a separate artifact.

### An internal GitLab, or a proxy that re-signs TLS

Put the root certificate in `ca/` as a `*.crt` file and rebuild — see
[`ca/README.md`](ca/README.md). It is trusted in both the build and runtime
stages, because behind a TLS-intercepting proxy it is `npm ci` that fails first
and the error does not obviously point at a missing root.

Node ignores the operating system's trust store by default, so a certificate
that `curl` accepts inside the container will still fail in the orchestrator
unless `NODE_EXTRA_CA_CERTS` is set. The image sets it to the system bundle
that `update-ca-certificates` rebuilds, so public roots and your private ones
both work, and nothing breaks when `ca/` is empty.

## OpenCode SDK version

`@opencode-ai/sdk` is pinned to **exactly `1.17.15`** — not a caret range.

The SDK is released in lockstep with the OpenCode server, so the SDK version *is* the server
version, and the consuming harness runs server **1.17.15**. The seed project declared
`"^1.0.0"` while importing from the `@opencode-ai/sdk/v2` subpath — a range wide enough to
resolve to an SDK whose generated client does not match the running server.

The two calls this project actually makes were verified against the `1.17.15` package's `/v2`
export before pinning:

- `client.session.create({ title, permission })` → `Session2.create(...)`, accepting `title`
  and `permission: PermissionRuleset`, returning `Session` (with `id`) on 200.
- `client.session.prompt({ sessionID, parts })` → `Session2.prompt(...)`, accepting
  `sessionID` and `parts: Array<TextPartInput | ...>`.

`PermissionRule` is re-exported from `@opencode-ai/sdk/v2`, so it is imported rather than
structurally re-declared.

## Scope

Implemented: file queue and GitLab Issues trackers, the orchestrator
poll/dispatch/reconcile loop, workspace management with hooks, the OpenCode agent runner,
workflow/config loading, prompt rendering, completion markers, stall detection and structured
logging.

Deliberately absent: Linear/Jira/GitHub/Bitbucket trackers, a terminal dashboard, an HTTP status
server, an interactive setup wizard, and container or CI configuration. A project's real
`WORKFLOW.md` is per-project config and lives in the consuming repository, not here.
