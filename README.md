# symphony-queue

An implementation of [Symphony](https://github.com/openai/symphony) that turns tracked work
items into isolated, autonomous coding-agent runs — with two deliberate departures from
upstream:

1. **The tracker is a directory tree on disk.** No Linear, no Jira, no API tokens. State is
   the folder a file sits in.
2. **The coding agent is [OpenCode](https://opencode.ai), not Codex.** Runs are driven over
   the `@opencode-ai/sdk` HTTP API against an OpenCode server.

It is a library plus a service: a poll loop that scans a queue directory, dispatches an agent
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
- **`rename(2)` is the claim.** Moving `todo/X.md` → `in-progress/X.md` is atomic within a
  filesystem, so the move itself is the lock. No lockfiles, no coordination service.
- **Crash recovery is free.** Whatever is sitting in `in-progress/` when the process starts is
  exactly the recovery set (SPEC §14.3).

Front matter must **not** carry a `state:` field — the directory is the single source of
truth, and a `state:` key found in a file is ignored with a warning. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full rules, including how queue files are treated
as untrusted input.

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
opencode:
  server_url: http://localhost:4096
---

Work on {{ issue.identifier }}: {{ issue.title }}.
```

No secret can enter this config: there is no API key, endpoint or credential field anywhere in
the schema, and the `$VAR` environment-variable resolver the seed project used to read a Linear
token is gone.

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

Implemented: the file queue tracker, the orchestrator poll/dispatch/reconcile loop, workspace
management with hooks, the OpenCode agent runner, workflow/config loading, prompt rendering.

Deliberately absent: any Linear/Jira/GitHub/GitLab/Bitbucket integration, the terminal
dashboard, the HTTP status server, the interactive setup wizard, and any container or CI
configuration. A project's real `WORKFLOW.md` is per-project config and lives in the consuming
repository, not here.
