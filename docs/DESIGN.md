# Design notes

Decisions that are load-bearing and non-obvious. Everything here is a rule the code depends
on, not a preference.

## 1. The directory is the single source of truth for state

A work item is one markdown file. Its `Issue.state` is derived **at read time from the name of
the parent directory**, and from nothing else:

| Directory | `Issue.state` | Dispatchable? | Terminal? |
|---|---|---|---|
| `todo/` | `Todo` | yes | no |
| `in-progress/` | `In Progress` | yes (resume) | no |
| `review/` | `In Review` | no — human gate | no |
| `done/` | `Done` | no | yes |
| `failed/` | `Failed` | no — via retry sweep | no |
| `cancelled/` | `Cancelled` | no | yes |

Front matter therefore **must not** carry a `state:` field. If a file does contain one it is
ignored and a warning is logged. There is deliberately no code path that reads it, no
reconciliation between the two, and no "the file says X but the folder says Y" case to
resolve — because two sources of truth for the same fact is the bug, not the mismatch.

`review/` is the human gate. `fetchCandidateIssues` returns `todo/` and `in-progress/` only,
so an item parked in `review/` is never picked back up by the orchestrator no matter how long
it sits there.

The practical payoff: `ls` is the dashboard. That is why this repo ships no terminal UI and no
HTTP status server — both existed in the seed project and both were cut.

## 2. `rename(2)` is the claim

`updateIssueState` is implemented as a `rename` of the file from one state directory to
another. Within a single filesystem `rename(2)` is atomic, so the rename *is* the lock: two
orchestrators racing to claim `todo/X.md` cannot both win, because the loser's `rename` fails
with `ENOENT`. There are no lockfiles, no lease records, and no coordination service.

Consequences the implementation has to honour:

- **All six state directories must live on the same filesystem.** A cross-device `rename`
  fails with `EXDEV`, and the atomicity argument evaporates. They are subdirectories of one
  queue root, so this holds by construction unless someone mounts one of them separately.
- **`updateIssueState` must be idempotent.** The file may already have moved — a crash
  mid-transition, or another mover won the race. So on `ENOENT` the tracker re-scans all six
  directories by `id` before failing. If the file is already in the requested directory, the
  call succeeds and does nothing. If it is somewhere else entirely, the move is retried from
  wherever it actually is.
- **Content edits never happen in place.** To rewrite front matter or the workpad, the tracker
  writes a `.tmp` file *in the same directory as the target* (same filesystem, so the
  subsequent rename is atomic), `fsync`s it, then `rename`s over the target. A reader either
  sees the whole old file or the whole new one, never a torn write. Writing the temp file to
  the system temp directory would reintroduce `EXDEV` and is specifically avoided.

## 3. Crash recovery is free

SPEC §14.3: scheduler state is intentionally in-memory and does not survive a restart. With a
file queue the recovery set needs no reconstruction — **anything sitting in `in-progress/`
when the process starts is exactly the set of runs that were live when it died.**

**v1 decision: those items are simply re-dispatched.** They are already in `In Progress`, and
`fetchCandidateIssues` returns that directory, so recovery falls out of the ordinary poll loop
with no special startup path. This is the deliberately dumb option:

- It assumes the agent's work is resumable, which is what the workpad in the item body is for
  — the agent reads back its own running plan and continues.
- It can re-run side effects that already happened. That is accepted for v1. A future version
  that needs stronger guarantees should record a `session_id` on the item (the field already
  exists in the schema) and resume the OpenCode session rather than starting a new one.

## 4. Retry lives in `failed/`

On an abnormal run exit the item moves to `failed/`, `attempts` is incremented, and
`next_retry_at` is set to now plus `backoffDelay(attempts)` — the same
`min(10000 * 2^(attempt-1), maxRetryBackoffMs)` from `orchestrator.ts` that SPEC §8.4
specifies, so there is exactly one backoff formula in the codebase.

A sweep on each poll moves due items (`next_retry_at` in the past) back to `todo/`. Items that
have reached the configured max attempt count stay in `failed/` and are never swept, so a
poison item cannot spin forever. `failed/` is not terminal — it is a holding pen with a timer.

## 5. Queue files are untrusted input

This is the security rule that shapes the whole module. **The agent writes its workpad into
the same file the orchestrator parses.** Front matter is therefore attacker-influenced by
construction — not hypothetically, but as the normal mode of operation. A prompt-injected
agent editing its own queue file is the threat model, and SPEC §15.5 explicitly declines to
assume tracker data is trustworthy.

So:

- **Every field is validated with zod.** Unknown keys are dropped, not passed through. Types
  are enforced, not coerced from whatever YAML produced.
- **`id` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.** No slashes, no dots-only, no leading
  dot, no empty string. An item whose `id` fails this is rejected outright.
- **Every path is built through `path_safety.ts`'s containment check** (SPEC §9.5,
  invariant 2). Even with the `id` regex in place, the path is independently resolved and
  verified to sit inside the queue root before any read, write, or rename. A crafted
  `id: ../../etc/passwd` never produces a path outside the root, and the belt-and-braces
  ordering is intentional: the regex is the policy, the containment check is the enforcement.
- **No front-matter value is ever interpolated into a shell command or a git URL.** Not the
  `branch` field, not `id`, not `title`. Hooks receive the workspace path and nothing derived
  from item content (SPEC §15.4 — hooks are trusted config, item content is not).
- **A malformed or unparseable file is logged and skipped.** It must never throw out of the
  poll loop, and it is **never auto-deleted or auto-repaired** — a file the orchestrator
  cannot understand is a file a human needs to look at, and silently removing it would destroy
  the evidence.

The one place this diverges from the SPEC: §11.1 says an ID-refresh call MUST fail rather than
silently omit a malformed requested record. Here a malformed file is omitted from
`fetchIssueStatesByIds` too. The orchestrator's reconciler treats an omitted ID as "no longer
visible" and leaves the run alone, which is the safe direction — and the alternative, letting
one corrupt file abort reconciliation for every running item, is worse in a queue where the
agent itself is the thing corrupting files.

## 6. OpenCode SDK version

`@opencode-ai/sdk` is pinned to **exactly `1.17.15`**.

The SDK ships in lockstep with the OpenCode server, so the SDK version is the server version,
and the consuming harness runs server 1.17.15. The seed project declared `"^1.0.0"` while
importing from the `@opencode-ai/sdk/v2` subpath — a range wide enough to resolve to a
generated client that does not match the running server, which is exactly the failure mode a
pinned harness is supposed to prevent. A caret range buys nothing here: there is one server
version to talk to and it is fixed at image build time.

Before pinning, the two calls this project actually makes were checked against the `1.17.15`
package's `dist/v2` type surface:

- `client.session.create({ title, permission })` — `Session2.create()` accepts `title?: string`
  and `permission?: PermissionRuleset`, and returns `Session` (which has `id`) on 200.
- `client.session.prompt({ sessionID, parts })` — `Session2.prompt()` accepts
  `sessionID: string` and `parts?: Array<TextPartInput | FilePartInput | ...>`, and
  `TextPartInput` is `{ type: 'text'; text: string; ... }`.

`PermissionRule` (`{ permission: string; pattern: string; action: PermissionAction }`) is
re-exported from `@opencode-ai/sdk/v2` via `dist/v2/client.d.ts`. The seed project
structurally re-declared it locally with a comment about "subpath export issues"; that was
unnecessary at this version, so the real type is imported and the local copy is gone. This is
the sort of drift a pin is meant to catch.

## 7. Things in the bootstrap brief that turned out to be wrong

See the end of this document — recorded as they were found.
