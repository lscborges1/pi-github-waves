# Design: pi-github-waves

## Summary

`pi-github-waves` is a reusable pi package that coordinates an explicit set of GitHub issues as a dependency graph. It validates every selected issue, presents a mandatory dry run, executes ready issues concurrently in isolated Git worktrees, monitors pull requests, performs bounded repairs, and releases downstream work only after its blockers are merged into the repository's default branch.

The package never merges pull requests. Human review and merge remain the quality gate.

## Goals

- Use GitHub Issues as the source of truth.
- Accept an explicit list of issue numbers for each run.
- Build a deterministic DAG from explicit dependencies.
- Require approval of a dry run before mutation.
- Start one isolated pi worker per ready issue, subject to a concurrency limit.
- Create each newly ready batch from a freshly fetched default branch.
- Resume safely after pi exits or crashes.
- Monitor PR checks and reviews and perform bounded, scoped repairs.
- Release an issue as soon as all of its own blockers are merged.
- Remain reusable across GitHub repositories.

## Non-goals

- Linear or other issue trackers.
- Dependency inference from titles, labels, chronology, code, or LLM output.
- Automatic ticket enrichment or rewriting.
- Automatic merge.
- A daemon or hosted service.
- Executing issues without the `agent: suitable` label.
- Selecting work by milestone, project, or label query.
- Project-controlled executable configuration or agent prompts in the first version.

## Decisions

- **Runtime:** local pi package.
- **Repository:** `/Users/lucasborges/www/borges-lab/pi-github-waves`.
- **Interface:** pi extension commands plus a workflow skill.
- **Selection:** explicit issue numbers, such as `#3 #4 #6`.
- **Eligibility:** every selected issue must have `agent: suitable`.
- **Dependencies:** native GitHub dependencies are authoritative; a body declaration is allowed only as a fallback.
- **Ticket quality:** strict deterministic validation; any invalid selected ticket blocks the whole run.
- **Lifecycle:** persisted runs resumed explicitly.
- **Review:** CI and technical review feedback can trigger bounded repairs; merge is always human.
- **Approval:** `/waves run` displays a confirmation and atomically approves the current plan before its first mutation.
- **Branch:** all operations use the repository's discovered default branch; no branch name is hard-coded.

## Architecture

The package combines a deterministic TypeScript extension with a procedural skill. The extension owns safety-critical mechanics. The skill explains ticket preparation, commands, and human intervention, but cannot alter the state machine.

### Modules

- **domain** — issue specification, DAG, wave levels, readiness, fingerprints, and run/issue state machines. No filesystem, process, Git, or network dependencies.
- **application** — `plan`, `run`, `resume`, and `status` use cases. Coordinates ports and owns idempotency rules.
- **adapters/github** — issues, dependencies, linked PRs, checks, and reviews through `gh` argument arrays.
- **adapters/git** — repository identity, fetch, refs, branches, commits, and worktrees through Git argument arrays.
- **workers** — pi subprocess lifecycle and structured JSON event capture.
- **repairs** — one generic repair controller consuming normalized CI or review findings; source-specific adapters normalize findings.
- **persistence** — approved plans, write-ahead events, snapshots, and run locks.
- **extension** — `/waves` commands, confirmation, progress, and textual status.
- **skill** — operating instructions only.

Domain and application modules depend on interfaces, not concrete adapters. Tests can replace every external system.

## Configuration

Configuration is read from `~/.pi/agent/pi-github-waves.json`. The first version does not load repository-controlled configuration.

Version 1 schema:

```json
{
  "schemaVersion": 1,
  "workerModel": "provider/model-or-null",
  "workerTools": ["read", "bash", "edit", "write"],
  "maxConcurrency": 3,
  "pollIntervalSeconds": 30,
  "maxCiRepairs": 2,
  "maxReviewRepairs": 2,
  "terminationGraceSeconds": 10
}
```

Missing values use built-in defaults. Unknown keys and invalid values fail preflight. `maxConcurrency` is 1–8; repair limits are 0–5; intervals and grace periods must be positive bounded integers. Environment variables may identify the config path but may not override individual values.

The normalized configuration and its SHA-256 hash are frozen into the approved plan. `resume` uses the frozen values. A later config edit affects only a new plan.

## Public interface

- `/waves plan #3 #4 #6` — fetch, validate, calculate the graph, write an **unapproved** plan, and show a mutation-free dry run.
- `/waves run` — revalidate the current unapproved plan, display a confirmation, and on confirmation atomically record `plan_approved` before dispatch.
- `/waves resume <run-id>` — acquire the run lock, reconcile external state, and continue safe work.
- `/waves status [run-id]` — show issue, worker, branch, PR, check, review, and blocker states without mutation.

`/waves run` refuses when there is no current unapproved plan, the plan is already active, or revalidation changes its fingerprint. Cancelling confirmation leaves the plan unapproved and causes no mutation.

The first version intentionally omits abort and cleanup commands. Ctrl+C terminates workers started by the current foreground command. Worktree cleanup is manual until ownership and deletion UX receive a separate design.

## Ticket contract

The parser recognizes exact, case-insensitive level-two headings. Every selected issue must contain all of these sections with non-whitespace content:

```markdown
## Context
## Objective
## Scope
## Out of scope
## Expected behavior
## Technical notes
## Acceptance criteria
## Test scenarios
## Dependencies
```

Portuguese aliases are accepted as fixed parser constants:

- `Contexto`, `Objetivo`, `Escopo`, `Fora de escopo`;
- `Comportamento esperado`, `Detalhes técnicos`;
- `Critérios de aceite`, `Cenários de teste`, `Dependências`.

A heading may appear once. Duplicate or unknown aliases do not satisfy a required section. Acceptance criteria and test scenarios must each contain at least one Markdown list item. The parser does not semantically judge prose quality.

Rollout, rollback, observability, i18n, privacy, and factory details are optional sections. Teams can include them, but version 1 does not guess when they apply.

Tests belong in the implementation issue. Schema and migration changes that must land atomically belong in the same issue. These authoring rules are documented by the skill but are not inferred by an LLM during preflight.

Any malformed or ineligible selected issue makes the plan non-runnable. The dry run lists every issue and every validation error so the user can fix the set and plan again; valid siblings do not proceed under a partially accepted plan.

## Dependencies

Dependency resolution is deterministic:

1. Read native `blocked by` relations from GitHub.
2. Parse `Blocked by: #3, #4` or `Bloqueado por: #3, #4` from the required Dependencies section.
3. If native dependencies exist, they are authoritative. If a non-empty body list also exists, normalized sets must match or preflight fails.
4. If native dependencies are empty, use the body list.
5. `None` or `Nenhuma` means an empty body list.
6. Never infer an edge.

Blockers outside the selected set are graph boundary nodes and are never dispatched. A cycle among selected or boundary nodes that lead back into the selected graph fails preflight.

### When a blocker is satisfied

For a selected blocker owned by the run, satisfaction requires its tracked PR to report `merged_at`, target the discovered default branch, and have its merge commit reachable from the current remote default-branch tip.

For a blocker completed before the run or outside the selected set, satisfaction requires:

- the issue is closed;
- GitHub reports at least one closing PR for that issue;
- at least one such PR is merged into the discovered default branch; and
- its merge commit is reachable from the current remote default-branch tip.

Squash and rebase merges are valid because verification uses the PR's recorded merge commit and reachability. Multiple linked PRs are allowed if at least one closing PR satisfies the rule. A manually closed issue, a PR targeting another branch, or a closed PR without merge does not satisfy a blocker and is reported as `needs_attention`.

A selected issue already satisfying this rule is recorded as `merged_preexisting` and is not dispatched.

## Plan and fingerprint

A plan records:

- schema version, run ID, repository owner/name, and remote URL;
- default branch name and remote tip OID;
- selected issue IDs, numbers, `updated_at`, labels, and parsed specification hashes;
- normalized dependency sets and boundary blocker observations;
- closing/merged PR observations for already completed blockers;
- topological level for display;
- proposed branch and worktree identities;
- frozen configuration and config hash.

The plan fingerprint is SHA-256 over canonical JSON with sorted object keys and sorted set-like arrays.

Immediately before approval, `/waves run` refetches all fingerprint inputs. Any change to issue `updated_at`, labels, parsed body, dependency sets, repository identity, default branch, boundary blocker status, or default-branch tip invalidates the plan. The user must run `/waves plan` again. This strict rule applies only before first dispatch; later external changes are handled by reconciliation.

The dry run shows all selected issues, validation failures, boundary blockers, edges, topological levels, proposed paths, and maximum concurrency. It performs no writes to GitHub or Git and starts no subprocesses.

## Scheduling semantics

Topological levels are displayed as “waves,” but they are not global barriers. An issue becomes ready as soon as all of **its own** blockers satisfy the merge rule. A failed or slow sibling does not prevent an unrelated downstream issue whose blockers are already satisfied.

At each dispatch cycle:

1. Fetch the remote default branch.
2. Reconcile blocker PRs and merge reachability.
3. Calculate ready issues from the current graph and available concurrency slots.
4. Capture the current remote default-branch OID as the batch base.
5. Create every worktree in that ready batch from that same OID.

A later batch repeats the process and therefore starts from an updated remote tip. The DAG defines eligibility; `maxConcurrency` only caps simultaneous workers.

## Worker contract

For each ready issue, the extension creates an external worktree under:

`~/.pi/agent/state/github-waves/<owner>/<repo>/<run-id>/worktrees/issue-<number>`

The branch is `agent/issue-<number>-<slug>`. A branch or path collision is reusable only when its persisted ownership metadata matches the run and issue; otherwise dispatch fails closed.

### Invocation

The adapter invokes pi without a shell:

```text
pi --mode json -p --no-session [--model MODEL] --tools TOOL_LIST --append-system-prompt PROMPT_FILE "Task: ..."
```

The subprocess cwd is the issue worktree. The prompt file is created with mode `0600`, contains the fixed worker contract, and is deleted after process exit. The task includes the immutable issue snapshot and run identifiers.

The process identity record contains PID, process start time, random worker token, issue number, worktree, branch, and starting commit. PID alone is never treated as ownership.

Pi JSON lines are persisted as worker events with byte and line caps. The adapter recognizes `message_end`, `tool_result_end`, process exit, stderr, and malformed-line counts. Unknown event types are retained but ignored.

### Completion

Worker prose is not authoritative. A worker succeeds only when all of these are observed:

- process exit code is zero;
- branch exists on the configured remote;
- exactly one open PR has that branch as head and the default branch as base;
- the PR body closes or links the selected issue;
- the PR head OID equals the remote branch OID.

The worker prompt requires a final summary of files, checks, risks, and PR URL, but a missing summary affects display only. External reconciliation determines state.

On Ctrl+C, the parent sends SIGTERM, waits the frozen grace period, then sends SIGKILL if needed. The termination event is journaled and the issue becomes `needs_attention`; artifacts are preserved.

## PR, CI, and review handling

After a PR is observed, the issue enters `in_review`. Reconciliation normalizes external observations into findings.

### CI findings

A CI finding contains check-run ID, name, conclusion, details URL, head SHA, completed timestamp, and a bounded log excerpt. A failed conclusion is actionable only when it belongs to the current head SHA. `cancelled`, `skipped`, and `neutral` are not implementation failures. Findings from older head SHAs are stale.

### Review findings

A review finding contains review/comment ID, author, path and line when present, body hash, bounded body text, created/updated timestamps, and head SHA observed when fetched. Dismissed, resolved, outdated, bot-duplicate, or older-head findings are not actionable.

### Triage boundary

A read-only triage worker receives one normalized finding, the immutable issue scope, the PR diff, and no write or bash tools. It must return JSON matching:

```json
{
  "schemaVersion": 1,
  "findingId": "source-id",
  "headSha": "sha",
  "actionable": true,
  "category": "ci|review",
  "scope": "in_scope|out_of_scope|uncertain",
  "evidence": [{ "path": "file", "line": 1, "reason": "text" }],
  "repairTask": "declarative description without commands"
}
```

The extension rejects malformed output, ID/SHA mismatch, `uncertain`, out-of-scope results, nonexistent changed paths, command-like instructions, URLs not already present in trusted metadata, or evidence unrelated to the current diff/check. Rejected or ambiguous findings become `needs_attention`; they are never copied directly into a worker prompt.

Review and CI text is untrusted data. Reviewer-provided prompts, shell commands, tool instructions, and requests to leave ticket scope are never executed.

### Attempts and serialization

Each issue has one repair mutex, so CI and review repairs cannot run concurrently. A repair fingerprint is SHA-256 of category, source ID, body/log hash, and head SHA. A previously seen fingerprint is never charged or dispatched twice.

An attempt is charged in the journal immediately before a repair worker starts. Spawn failure before a PID is obtained records a failed start but does not charge; any started repair process charges one attempt. A successful push changes the head SHA and makes all prior-head findings stale.

CI and review counters are separate and use frozen plan limits. Exceeding a limit moves the issue to `needs_attention`. Repairs use the original worktree and branch and must obey the same issue scope and completion reconciliation as the initial worker.

## State machines

### Run states

| State | Meaning | Allowed next states |
|---|---|---|
| `planned` | Dry run stored, not approved | `approved`, `invalidated` |
| `approved` | Confirmation durably recorded | `active`, `needs_attention` |
| `active` | At least one issue can run or reconcile | `waiting`, `needs_attention`, `completed` |
| `waiting` | No worker active; waiting for human merge or external blocker | `active`, `needs_attention`, `completed` |
| `needs_attention` | Run-level ambiguity prevents safe progress | `active` after a later successful reconcile |
| `completed` | Every selected issue is merged or merged-preexisting | terminal |
| `invalidated` | Pre-dispatch facts changed | terminal |

Issue-level `needs_attention` does not force run-level `needs_attention` when independent work remains safe.

### Issue states

`validated`, `blocked`, `ready`, `running`, `in_review`, `repairing_ci`, `repairing_review`, `needs_attention`, `merged_preexisting`, and `merged`.

The domain module defines an explicit transition table. Invalid transitions fail closed. `merged` and `merged_preexisting` are terminal. Failed siblings do not cancel independent work; their descendants remain blocked.

## Persistence, durability, and ownership

Run state lives at:

`~/.pi/agent/state/github-waves/<owner>/<repo>/<run-id>/`

Files:

- `plan.json` — immutable canonical approved or unapproved plan;
- `events.jsonl` — append-only write-ahead journal;
- `snapshot.json` — derived cache, never authoritative;
- `lock.json` — owner metadata accompanying an OS advisory lock;
- `workers/` — bounded structured worker event files;
- `worktrees/` — issue worktrees.

Every journal event has `schemaVersion`, UUID `eventId`, monotonic `sequence`, timestamp, run ID, optional issue number, type, payload, and `idempotencyKey`. Unknown schema versions stop reconciliation.

For each side effect, application code:

1. appends and `fsync`s an `*_intent` event with an idempotency key;
2. checks whether the external object already exists with matching ownership;
3. performs the side effect if absent;
4. observes the resulting external identifier;
5. appends and `fsync`s `*_observed`.

Snapshots are rebuilt by replay, written to a temporary file, `fsync`ed, and atomically renamed. A corrupt or missing snapshot is discarded. A truncated final journal line is ignored only if it is the final line; any earlier corruption stops reconciliation.

The lock records hostname, PID, process start time, random owner token, and acquisition time. The OS lock is authoritative. Stale metadata without an active OS lock may be replaced after journaled recovery.

Branches, PR bodies/comments, and worktree metadata include a non-secret ownership marker containing run ID and issue number. Reconciliation uses both the marker and expected repository/head/base identities. This prevents duplicate workers, branches, and PRs after a crash.

No credentials or full untrusted review bodies are persisted in plan or snapshot files.

## Reconciliation and recovery

`resume` reacquires the lock and treats persisted state as evidence, not truth. It queries GitHub, Git, worktrees, refs, PRs, checks, reviews, and recorded process identities, then derives safe transitions. Repeating reconciliation with unchanged external state produces no side effects.

Recovery rules:

- **Network failure, rate limit, or auth expiry:** record a retryable observation, honor `Retry-After` when present, stop the current reconcile without changing issue state, and tell the user to resume.
- **Fetch failure:** dispatch nothing; existing workers are not killed.
- **Partial worktree creation:** reuse only when path, branch, base OID, and ownership all match; otherwise `needs_attention`.
- **Push failure:** worker cannot complete; preserve branch/worktree and mark the issue `needs_attention`.
- **Parent crash after intent:** resume checks for the owned external object before repeating the operation.
- **Worker disappears:** reconcile branch and PR first; if completion conditions are not met, mark `needs_attention`.
- **PR closed without merge:** `needs_attention`.
- **Unexpected branch movement or multiple matching PRs:** `needs_attention`.
- **Check/review API temporarily unavailable:** do not dispatch repairs or release dependents; retain prior stable state and stop the reconcile.
- **Merge observed but reachability fetch fails:** do not release dependents until a later successful fetch verifies it.

## Safety

Preflight performs no external mutation and fails on malformed tickets, ineligible labels, cycles, dependency mismatch, missing `gh` authentication, insufficient permissions, unsupported remotes, invalid configuration, or unattributed collisions.

All process calls use executable and argument arrays without shell interpolation. Repository identifiers, issue numbers, slugs, and paths are validated and normalized. Output is bounded before entering model context.

No module interface exposes merge. Tests scan GitHub and Git adapter operations and behaviorally assert that merge commands/API endpoints cannot be invoked.

The package does not automatically delete branches or worktrees in version 1. This deliberately trades disk space for recoverability and avoids underspecified destructive cleanup.

## Observability

`/waves status` displays the run ID, plan fingerprint, run state, each issue's state and blockers, topological level, worker identity, worktree, branch, commit, PR, current checks, repair counters, stale/actionable findings, and the exact next command.

Structured logs include timestamps, run/issue IDs, operation names, outcomes, and sanitized errors. Secrets, prompt files, complete CI logs, and complete review bodies are excluded.

## Testing

### Unit

- exact-heading ticket parser and aliases;
- dependency normalization, mismatch, boundary nodes, cycles, and topological levels;
- blocker satisfaction for merge, squash, rebase, multiple PRs, manual close, and wrong base;
- canonical plan fingerprint and invalidation inputs;
- run and issue transition tables;
- readiness without global wave barriers;
- repair fingerprints, stale-head handling, serialization, and counters;
- identifier and path normalization;
- event replay, truncated tail, corruption, and snapshot derivation.

### Integration

Temporary Git repositories and fake GitHub/pi adapters cover:

- dry run with zero mutations;
- single issue from plan through PR observation;
- worktrees from the expected remote default-branch OID;
- DAG dispatch with concurrency limits and sibling isolation;
- human merge followed by resume and downstream dispatch from a newer OID;
- crash at every intent/side-effect/observed boundary;
- lock contention and stale metadata;
- worker termination and disappearance;
- cancelled-by-push versus failed CI;
- malicious, stale, duplicate, and out-of-scope reviews;
- repair retry exhaustion;
- network, auth, rate-limit, fetch, push, and partial-worktree failures;
- journal/GitHub divergence and duplicate-object prevention.

### End to end

A local fixture repository exercises command registration and a full run against fake executables placed first on `PATH`. It verifies planning, confirmation, worker streaming, PR waiting, process restart, merge reconciliation, and downstream release. Live GitHub tests are optional and excluded from default CI.

## Vertical delivery slices

1. **Safe planner:** package loading, config, GitHub reads, strict parser, DAG, fingerprint, and mutation-free `/waves plan`.
2. **One-issue tracer:** approval, journal, lock, Git worktree, one pi worker, PR reconciliation, and `/waves status`.
3. **Resumable graph:** concurrency, dependency-by-dependency scheduling, human merge reconciliation, crash recovery, and downstream release.
4. **Bounded repair:** normalized CI/review findings, read-only triage, serialized repair workers, stale finding handling, and limits.
5. **Hardening:** recovery matrix, ownership collision tests, output bounds, documentation, and end-to-end validation.

Each slice is demonstrable through the public commands and extends the same state machine. CI and review use one repair abstraction rather than separate orchestration subsystems.

## Success criteria

A user can select valid, explicitly linked GitHub issues; approve a deterministic plan; close pi during human review; later resume; and have only newly unblocked issues dispatched from a freshly fetched default branch, without duplicate workers, branches, or PRs. Valid CI or review findings can trigger bounded repairs, untrusted instructions cannot escape ticket scope, and no package path can merge code.
