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

## 7. Other implementation choices worth knowing

**Every call does one full scan of all six directories.** `fetchCandidateIssues`,
`fetchIssuesByStates`, `fetchIssueStatesByIds` and `updateIssueState` each re-read the queue
from disk rather than caching. That is deliberate: the whole premise is that the filesystem is
the truth and anything may have moved since the last look — a human dragging a file between
folders is a supported operation. It also means there is no cache to invalidate after a
rename. For a personal queue of tens-to-hundreds of small markdown files this is cheap; if it
ever stops being cheap, the fix is a stat-based cache, not a database.

**`blocked_by` holds ids, and states are resolved at read time.** Front matter stores a list
of item ids; the tracker resolves each to its current directory-derived state during the scan
it already performs. A blocker id that is not in the queue resolves to `state: null`, which
the orchestrator's `shouldDispatch` treats as non-blocking. Invalid blocker ids are dropped at
parse time — they are metadata and never become paths.

**`Issue.url` is always `null`.** There is no web UI to link to, and a `file://` path would
only serve to get interpolated into a prompt. The item's `id` is its identifier and its
workspace key.

**A `Failed` transition is the failure-recording operation.** Rather than widening the
`TrackerAdapter` interface, `updateIssueState(id, 'Failed')` is what increments `attempts` and
stamps `next_retry_at`. The early-return on "already in the target directory" is what keeps
this from double-counting when the same transition is applied twice.

**Ordering under crash.** The rename lands before the bookkeeping rewrite, in both the failure
path and the retry sweep. A crash in the window leaves an item in `failed/` with stale
counters (it retries earlier than intended) or in `todo/` with a stale `next_retry_at` (which
is only ever read in `failed/`, so it is inert). Both are strictly better than risking the
file itself, which is why the order is this way round. A `failed/` item with a null
`next_retry_at` is treated as due, so a crash cannot strand an item.

**Strict parsing, on purpose.** A field of the wrong type makes the whole item malformed and
skipped, rather than being coerced or defaulted. SPEC §11.3 permits normalizing unusable
nullable fields to `null`; that latitude is used only for `branch`, `jira` and `session_id`,
where a value failing its shape check is dropped precisely because it is the kind of value
that must never be trusted. Everything else is strict, because in this design an item the
orchestrator cannot understand should stop and be looked at, not be silently reinterpreted.

## 8. Things in the bootstrap brief that turned out to be wrong

Three, all minor, none changing the shape of the design.

**1. `path_safety.checkContainment` was already broken in the seed code.** The brief tells you
to build every queue path through it (§4.6), which is right — but as copied it tested
`relative.startsWith('..')`, which rejects any path whose *filename* merely begins with two
dots. `queue-root/..foo` is contained, and the check said it was not. The traversal test in
the brief's required list (`id: ../../etc/passwd`) passes either way, so the bug would have
survived the stated acceptance criteria. Fixed to test a path-segment boundary
(`relative === '..' || relative.startsWith('..' + sep)`), with tests for both directions.
Note this bug only ever over-rejected, so nothing unsafe was previously admitted.

**2. `attempts` and `next_retry_at` had no orchestrator caller.** Design rule 5 says a failed
run moves the item to `failed/` with incremented attempts. The tracker implemented and tested
that, but nothing called it in a live run: `SymphonyOrchestrator.onWorkerExit` recorded retries
only in its in-memory `retryAttempts` map and never notified the tracker. This was left undone
deliberately at bootstrap because it meant changing ported orchestrator code.

**Now fixed — see §9, which turned out to be the larger half of the same bug.**

**3. The brief's file list left two dead config sections behind.** It says to strip
`TrackerRawSchema`'s Linear fields, but `config.ts` also carried a whole `codex` section
(`codex app-server`, `approval_policy`, `thread_sandbox`) and a `server` section for the HTTP
dashboard. Both are meaningless here — the first names the wrong agent, the second configures
a component the brief explicitly cuts — and the first would have failed the brief's own
`grep -ri "codex"` acceptance check. Both removed, along with the `$VAR` environment-variable
resolver, which existed solely to read a Linear API key. There is now no code path by which a
secret can enter the config at all, which is a property worth keeping.

One thing the brief was right about that is worth restating: writing the tests first was not
enough on its own. Every test in `tracker_file_queue.test.ts` passed on the implementation's
first run, which is exactly when a suite deserves suspicion. Deliberately breaking the
implementation in seven places — id validation, the `state:` guard, the candidate filter, the
retry deadline, the malformed-file guard, the idempotency short-circuit, and the atomic-write
temp file — caught six and exposed one genuinely weak test. The idempotency test asserted an
outcome that `rename(2)` produces anyway when source and target are the same path, so it could
not tell the short-circuit from its absence. Replacing it with an assertion about `attempts`
not double-counting is what made that branch real, and it also surfaced that the ENOENT
re-scan path had no coverage at all.

## 9. Exit transitions: the orchestrator records the outcome, the agent does not

The state machine did not terminate. `dispatchIssue` moved an item `Todo → In Progress`, but
`onWorkerExit` wrote the outcome only into the in-memory `completed` set and `retryAttempts`
map. Nothing ever moved the file out of `in-progress/`.

That is fine for exactly as long as the process lives, and broken the moment it restarts:
`completed` is gone, `fetchCandidateIssues` returns `in-progress/` by design (§3, crash
recovery), and so **every item that had already finished was dispatched again** — real agent
turns, real tokens, on work that was done. The recovery mechanism and the missing exit
transition combined into a loop.

The seed project did not have this bug because in the Linear design the *agent* moved the
ticket, using a `linear_graphql` MCP tool it was handed. Dropping Linear dropped the
transition with it, and there is no equivalent here: the agent has no queue tool, does not
know where the queue root is, and — per §5 — deliberately should not.

**So the orchestrator owns exit transitions.** `onWorkerExit` is now `async` and calls
`updateIssueState` before returning:

- **Normal exit → `In Review`.** Note what this does *not* claim. The orchestrator does not
  know the work is correct or complete, only that the agent stopped taking turns. `In Review`
  is the human gate (§1), so "the agent finished" and "a human should look at this" are the
  same event, and no judgement about quality is being encoded.
- **Abnormal exit → `Failed`**, which is what finally makes the tracker's `attempts` /
  `next_retry_at` bookkeeping and its `maxAttempts` ceiling run in a live system.

Two consequences worth stating:

**Only one retry schedule may be live at a time.** With the tracker recording failures, the
in-memory `retryAttempts` entry became a second scheduler for the same item, with its own
counter that resets on restart and no max-attempts ceiling. So the in-memory schedule is now a
*fallback*: it is populated only when the tracker transition throws. When the tracker accepts
it, the durable record owns the retry and the item is left unclaimed — it is in `failed/`, so
`fetchCandidateIssues` will not return it until the sweep decides it is due.

**Keeping the queue root away from the agent stays intact.** The alternative fix was to give
the agent a `queue_move` tool. That would have put an agent-writable path into the queue for
the sake of a transition the orchestrator already has every fact needed to make — and §5's
whole premise is that the agent is the untrusted writer here. The orchestrator moving the file
is both the smaller change and the one that keeps the agent's only queue surface being the
workpad inside its own item.

## 10. GitLab Issues as a second tracker

`GitLabTracker` sits beside `FileQueueTracker` behind the same four-method
`TrackerAdapter`. `tracker.kind` picks one. Neither is going away: the file
queue needs no network, no token and no server, which is what makes it the
offline test path and the zero-risk first run, and it is what most of this
suite exercises. GitLab is for real work.

### State is labels, and we always send the whole set

A GitLab issue has only `opened` and `closed`, so workflow state lives in a
`symphony::<state>` label. The obvious implementation — add the new label,
remove the old — is two requests, and a crash between them leaves an issue
wearing two states.

So every transition sends the **full label set** on one `PUT`: existing labels
minus every `symphony::*`, plus the target. One request, no intermediate state,
and a human's `bug` or `priority::2` survives untouched.

The useful consequence is that **this does not depend on scoped labels**, which
are a Premium feature. Mutual exclusion is enforced by us computing the set, not
by GitLab enforcing the `::` convention. On Premium the labels additionally
render as key/value and are exclusive in the UI, which is nice and changes
nothing here. The adapter behaves identically on Free.

An issue carrying no `symphony::` label is not ours and is skipped, never
adopted. An issue carrying *two* is also skipped, with a warning — only a hand
edit or another tool can produce that, and refusing to guess is the same call
the file queue makes about a malformed file.

### There is no atomic claim, and that is the real cost

The file queue gets a lock for free: `rename(2)` either moves the file or fails
with `ENOENT`, so two orchestrators racing to claim an item cannot both win
(§2). The Issues API has no compare-and-swap — no "set this label only if it is
currently todo" — so that guarantee does not survive the move to GitLab.

With a single orchestrator process the in-memory `claimed` set is the lock and
double-dispatch cannot happen. With two orchestrators polling one project, it
can. This is a genuine capability the file queue has and this adapter does not,
and it is recorded here rather than papered over with a read-after-write check
that would detect the race without preventing it.

### What GitLab is better at

- **`Issue.url` is real.** In the file queue it is deliberately `null` (§7).
  Here it is the web URL, which means the human gate is a page you can open from
  a phone rather than an `ls` on one particular machine.
- **MRs link themselves.** An MR that says `Closes #42` shows up on the issue,
  so `review/` has a review surface without symphony doing anything.
- **Blockers are first-class** — where the tier allows. `blocks` /
  `is_blocked_by` links are Premium; on Free the links endpoint only ever
  returns `relates_to`, which is not a blocker, so `blockedBy` comes back empty
  and dispatch proceeds. Degrading to "no blockers" is the right shape either
  way, and links are fetched only for `Todo` issues because `shouldDispatch`
  consults them nowhere else.

### Secrets still cannot enter the config

`config.ts` gained `base_url`, `project_id`, `label_prefix` and `closed_states`
— and deliberately **no** token field. `SYMPHONY_GITLAB_TOKEN` is read from the
environment in `main.ts`, so the property §8.3 established holds: there is no
code path by which a credential reaches a file on disk. `validateDispatchConfig`
checks the variable is present so a missing token is reported by the ordinary
preflight instead of failing on the first poll.

Errors never include the response body. A GitLab error page can echo the request
that produced it, and the token travels in a `PRIVATE-TOKEN` header.

### Deployment consequence, for the harness side

This is the one thing that gets worse. Symphony currently runs with no
credentials and no egress at all. Polling GitLab means it needs a project token
and a route to the API, so that property goes away.

The mitigation is better than what it replaces: give symphony a **project**
access token with the **Reporter** role, which can read and write issues on one
project and cannot push code at all, and give the agent a separate Developer
token for the repository. Neither can do the other's job, so a compromised
orchestrator can vandalize issue text and nothing else. Note the role does the
constraining — `api` is full API access for that project, and there is no
issues-only scope.

## 11. Inline review discussions: what the diff decides, and what the model only claims

Phase 3 posts a finding as a comment on its own diff line. The machinery is small; the
judgement around it is not, and three of the decisions below are the kind a later reader
would "simplify" straight back into the bug they were written to prevent.

### The old/new boundary is absolute. Added-versus-context is not.

`positionFor` (`review/diff.ts`) maps a finding onto GitLab's position contract. A finding
carries a `lineType` the MODEL wrote, and the question is how far to trust it.

**`removed` is its own world and nothing may cross into it.** A removed line exists only in
the pre-image, so the number names an OLD-file line and the comment belongs in the left
gutter. Resolving a removed finding by new-file numbering is exactly how a comment lands on
the wrong *side* of the diff — the failure the design report calls the worst in the plan,
because it is visible, wrong, and on someone else's merge request. Two tests exist for no
other purpose than to assert this; deleting the removed branch fails four.

**`added` and `context` both name a line of the NEW file**, so the number identifies one
physical line and the diff itself says which kind it is. The first implementation demanded
the model's label match, and a live review of five Python files placed NONE of its seven
findings: a one-line change reads to a model as "line 6 now says X" — `context` — where the
diff says `added`.

Loosening that in both directions fixed the first problem and caused a worse one. A comment
describing `JSONLinesDataSource` landed on an untouched line inside `CSVDataSource`, because
the type match had quietly been doing a SECOND job: corroborating the line NUMBER. "Added" is
a specific claim — this line is part of the diff's additions — and when the diff disagrees,
the model is wrong about something, most likely the number.

So the leniency is **one-directional**:

| Model claims | Diff says | Result |
| --- | --- | --- |
| `context` | `added` | placed — the label added nothing the diff lacked |
| `added` | `context` | REFUSED — the number is not corroborated |
| `removed` | anything in the new file | never resolved by new-file numbering |

Ten consecutive live placements were correct after this change. It is not a heuristic to tidy
into symmetry.

### The removed-line path is correct, tested, and appears never to be taken

Across every live run, the reviewing model described deletions but anchored them on the
ADJACENT ADDED line, citing new-file numbers. It never emitted `lineType: "removed"`.

Left exactly as it is, deliberately. Pushing the model toward removed-line reporting would buy
a marginally better anchor and spend it on the only path that can produce a wrong-side
comment. An unexercised safety net is a good outcome here, not a gap.

### A Reporter token cannot resolve a discussion it authored — confirmed, 403

Left open by the design and by the phase 3 handoff, which flagged it as worth deciding early.
It was not designed around in either direction: `resolveDiscussion` returns `boolean` and turns
403/404/405 into `false` rather than an exception, the supersede reply is posted FIRST and
unconditionally, and resolution is treated as a bonus. So the answer stayed out of the
architecture.

Production answered it. On a re-review, all four prior threads were replied to and all four
resolves came back **403**. The reply-only fallback is therefore the normal path here, not a
degraded one: prior-revision threads carry a "superseded by `<sha>`" reply and stay **open**.

Nothing needs changing, and widening the review token to buy thread resolution would trade the
boundary the whole deployment rests on for tidier threads. `review_inline_superseded` reports
`resolvePermitted`, so if a future GitLab version or role changes this, the log says so without
anyone having to go looking.

**A consequence worth knowing before it surprises someone:** re-review is whole-diff, not
incremental. A new head SHA re-reviews the merge request against its base, so a finding about
untouched code is re-raised as a NEW thread on the new revision while the old one is superseded.
A trivial push therefore produces a fresh thread per surviving finding. That is correct — the
merge request is what gets merged, not the last push — but thread count grows with pushes, and
if that becomes the dominant noise complaint the change to consider is replying "still present
at `<sha>`" to the existing thread instead of opening a new one. Not done here: an old thread's
line may not exist at the new revision, and re-anchoring it is the guessing this phase forbids.

### Unplaceable is ordinary, and the note must never imply approval

Every `InlineSkipReason` is a normal answer. A review that places half its findings and lists
the rest is a correct review; one that places a finding on the wrong line is not.

With inline on, the summary note lists only what FELL BACK — and that produced a note reading
"4 findings were posted as inline comments" directly above "No findings.". Read quickly, that
says the reviewer found nothing, which is the one meaning silence must never carry. An empty
list now states which emptiness it is: nothing fell back, or nothing was found.

### The bug this phase produced four times

Not a logic error. Four times, correct code and thorough tests were joined by a wire nothing
exercised:

1. The worker mapped the diff bodies away one line after computing them — inline placement was
   impossible in production. 779 tests green.
2. The publisher read placement material from a field only tests populated. Feature 100% inert.
   779 green.
3. `main.ts` never passed the config flag to the publisher. Feature off. 784 green.
4. `main.ts` never passed `diffEndpoint` to the client. Setting inert. 801 green — and the
   source-text guard written for (3) *also* missed it, matching the same words in a nearby log
   line at different indentation.

Every one was found by deliberately breaking the implementation, none by writing more tests.
The suite was not weak; it was complete at every layer and blind to the joins, because each
layer's tests construct their own inputs. `main.ts` is the worst case, since importing it boots
the CLI — which is why `review/pipeline.ts` exists: factories there are importable, so the
deployment path can be tested behaviourally instead of grepped for.

**Standing practice, extending §8: after the suite is green, break the wires, not just the
logic.** Delete an argument at a call site and see whether anything fails.
