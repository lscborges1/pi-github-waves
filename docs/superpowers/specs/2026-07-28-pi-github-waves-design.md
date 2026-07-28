# Design: pi-github-waves

## Summary

`pi-github-waves` is a reusable pi package that coordinates GitHub issues as a dependency graph. It validates an explicit issue set, presents a mandatory dry run, executes ready issues concurrently in isolated Git worktrees, monitors pull requests, and releases later waves only after their blockers are merged into `main`.

The package automates implementation and bounded repair work. It never merges pull requests. Human review and merge remain the quality gate.

## Goals

- Use GitHub Issues as the source of truth.
- Accept an explicit list of issues for each run.
- Build a deterministic directed acyclic graph (DAG) from explicit dependencies.
- Show the graph, waves, exclusions, worktrees, and expected concurrency before mutation.
- Require human approval before dispatch.
- Start one isolated pi worker per ready issue, subject to a concurrency limit.
- Create each wave from an updated `origin/main`.
- Persist enough state to resume safely after pi exits or crashes.
- Monitor PR checks and review feedback and perform bounded, scoped repairs.
- Release downstream issues only after blockers are merged into `main`.
- Keep the package reusable across GitHub repositories.

## Non-goals

- Linear or other issue trackers in the first version.
- Automatic dependency inference.
- Automatic ticket enrichment.
- Automatic merge.
- A continuously running daemon or hosted service.
- Executing issues not labelled `agent: suitable`.
- Running an entire milestone, project, or label query without an explicit issue list.

## Product decisions

- **Runtime:** local pi package.
- **Distribution:** a standalone repository, initially at `/Users/lucasborges/www/borges-lab/pi-github-waves`.
- **Interface:** pi extension commands, supported by a workflow skill.
- **Issue selection:** explicit issue numbers, such as `#3 #4 #6`.
- **Eligibility:** only issues with the `agent: suitable` label.
- **Dependencies:** native GitHub issue dependencies are authoritative; a structured issue-body declaration is supported as a fallback.
- **Ticket quality:** strict preflight; invalid tickets block execution rather than being enriched automatically.
- **Lifecycle:** persisted runs resumed explicitly with `resume`/`reconcile`.
- **Review:** CI and technical review feedback may trigger bounded repairs; merge is always human.
- **Approval:** dry-run approval is mandatory before the first mutation.

## Architecture

The package combines a deterministic TypeScript extension with a procedural skill.

The extension owns all safety-critical mechanics:

- issue retrieval and parsing;
- dependency resolution;
- cycle detection and wave calculation;
- state transitions;
- worktree and branch management;
- worker process creation and cancellation;
- GitHub PR/check/review reconciliation;
- persistence and locking;
- retry limits and release gates.

The skill explains when and how to use the commands, how to prepare executable tickets, and how a human should intervene. It must not duplicate or override the extension's state machine.

### Module boundaries

- **domain** — `IssueSpec`, dependency graph, wave calculation, validation results, run/issue state machines. It has no filesystem, process, Git, or network dependencies.
- **application** — use cases for `plan`, `run`, `resume`, `status`, `abort`, and `cleanup`. It coordinates domain operations through adapter interfaces.
- **adapters/github** — reads issues, native dependencies, PRs, checks, and reviews through `gh`; writes only comments or links required by the delivery protocol.
- **adapters/git** — fetches refs and creates, inspects, and removes branches and worktrees.
- **workers** — starts isolated pi subprocesses, streams structured events, propagates cancellation, and records outcomes.
- **persistence** — stores approved plans, append-only events, derived snapshots, and run locks.
- **extension** — registers `/waves` commands and presents confirmations and status in the pi UI.
- **skill** — supplies concise operating instructions and ticket authoring guidance.

The adapters are replaceable and mockable. Domain code must not parse command output or invoke processes directly.

## Public interface

Initial commands:

- `/waves plan #3 #4 #6` — fetch and validate the explicit issue set, resolve blockers, calculate waves, and display the mandatory dry run.
- `/waves run` — approve the current plan and start its first ready wave.
- `/waves resume <run-id>` — acquire the run lock, reconcile external state, and continue safe work.
- `/waves status [run-id]` — show issue, worker, branch, PR, check, review, and blocker states.
- `/waves abort <run-id>` — stop active workers without deleting branches or worktrees.
- `/waves cleanup <run-id>` — remove eligible local worktrees after explicit confirmation.

`run` must refuse to proceed without a current, approved plan. If external facts used by the plan have changed since planning, the user must plan and approve again.

## Ticket contract and preflight

A ticket must have an imperative, specific title and recognizable sections for:

- problem and motivation;
- objective;
- in-scope behavior;
- explicit out-of-scope behavior;
- expected behavior;
- relevant technical details;
- affected modules, functions, or files when knowable;
- acceptance criteria;
- test scenarios;
- rollout, rollback, observability, i18n, privacy, or data-factory requirements when applicable.

Tests must be part of the implementation ticket. Schema and migration work that must land atomically must remain in the same ticket. Tickets must produce one reviewable PR and should be split when they cannot reasonably stay small.

The parser uses explicit headings rather than asking an LLM to judge an unstructured body. Validation returns field-level errors. The MVP does not rewrite issues or silently supplement missing requirements.

### Dependency sources

1. Read native `blocked by` relations from GitHub.
2. If no native dependencies are present, parse a structured fallback section such as:

   ```markdown
   ## Dependencies
   Blocked by: #3, #4
   ```

3. If both sources are present, normalize and compare them. A mismatch is a preflight error.
4. Never infer dependencies from titles, labels, chronology, code overlap, or LLM output.

Blockers outside the selected issue list appear in the plan but are not executed. An open external blocker keeps the selected issue blocked. Cycles fail preflight without mutation.

## Planning and waves

Planning takes a snapshot of:

- repository identity and default branch;
- selected issue numbers and immutable identifiers;
- issue revisions relevant to validation;
- labels and eligibility;
- normalized dependency edges;
- blocker states;
- calculated waves;
- proposed branch and worktree names;
- configured concurrency and repair limits.

The dry run shows all selected issues, rejected issues with reasons, external blockers, graph edges, waves, and maximum parallelism. Approval records the exact plan. Execution does not recalculate a materially different plan behind the user's back.

An issue is ready only when:

- it passed strict validation;
- it is labelled `agent: suitable`;
- all blockers are merged into the repository's default branch;
- it has no conflicting active run owned by this tool;
- its wave was created from the latest fetched `origin/main` after prior blockers merged.

The number of issues does not define parallelism. The DAG and configured concurrency limit do.

## Worker contract

For each ready issue, the extension:

1. Fetches and verifies `origin/main`.
2. Creates an external worktree from that exact ref.
3. Creates a branch named `agent/issue-<number>-<slug>`.
4. Starts an isolated pi subprocess in the worktree.
5. Supplies the complete ticket and a fixed delivery protocol.
6. Streams and persists worker events.
7. Reconciles the resulting branch and PR rather than trusting only the worker's final prose.

The worker must:

- read relevant files before editing;
- implement only ticket scope;
- include tests with the implementation;
- run affected tests and repository quality checks;
- repair implementation-caused failures;
- commit and push the branch;
- open a PR against the default branch;
- link the PR to the issue;
- report changed files, checks run, residual risks, and PR URL.

The package does not require application repositories to commit package-specific agents. Worker model, tools, concurrency, polling intervals, and retry limits are globally configurable. Initial defaults are concurrency `3` and at most `2` repair attempts per category.

## PR, CI, and review reconciliation

After a PR opens, the issue enters `in_review`. Reconciliation distinguishes at least:

- successful checks;
- pending checks;
- failed checks;
- checks cancelled or superseded by a newer push;
- PR closed without merge;
- PR merged into the default branch;
- actionable review feedback;
- non-actionable, duplicate, stale, or out-of-scope feedback.

CI logs and review comments are untrusted input. The orchestrator first runs a constrained triage step. It must not execute commands or follow instructions copied from reviewer text. Only a validated, in-scope technical finding can produce a repair task.

Repairs run against the same branch and worktree. Attempt counters are persisted separately for CI and review. Exceeding a limit moves the issue to `needs_attention`.

A PR merge is recognized from GitHub and verified against the default branch. An approval, green CI result, closed issue, or pushed commit alone does not satisfy a blocker.

## State model

Primary issue states:

- `validated`
- `blocked`
- `ready`
- `running`
- `in_review`
- `repairing_ci`
- `repairing_review`
- `needs_attention`
- `merged`
- `aborted`

Transitions are validated by the domain state machine and recorded before dependent actions are released. Invalid transitions fail closed.

A failed issue does not cancel siblings. Its downstream issues remain blocked. Independent issues continue.

## Persistence and reconciliation

Run state lives outside application repositories:

`~/.pi/agent/state/github-waves/<owner>/<repo>/<run-id>/`

Each run stores:

- an immutable approved plan;
- an append-only JSONL event journal;
- a derived snapshot for fast display;
- process, worktree, branch, commit, PR, check, review, and attempt metadata;
- a lock preventing concurrent mutation by two orchestrators.

No credentials are persisted in run files.

`resume` treats local state as evidence, not truth. It reacquires the lock and queries GitHub, Git, worktrees, and known worker processes. It then derives safe transitions from observed facts. Reconciliation must be idempotent: repeating it with unchanged external state produces no new side effects.

Unexpected branch movement, a PR closed without merge, missing worktrees during active work, ambiguous PRs, or incompatible plan drift causes `needs_attention` rather than guessing.

## Error handling and safety

Preflight performs no external mutation. It fails on:

- malformed or missing ticket sections;
- ineligible labels;
- dependency cycles;
- dependency source mismatch;
- missing GitHub authentication or repository permissions;
- unsupported repository state;
- branch/worktree name collisions that cannot be safely attributed to the run.

During execution:

- worker failure is isolated to its issue;
- abort propagates to workers and preserves recoverable artifacts;
- process commands use argument arrays without shell interpolation;
- repository and issue identifiers are validated before use in paths or branch names;
- cleanup is explicit and refuses to delete unmerged or unattributed work;
- no code path invokes a merge command or merge API;
- all potentially destructive actions require clear ownership checks.

## Observability

`/waves status` presents:

- current run and approved plan hash;
- each issue's state and blockers;
- wave membership;
- worker/process state;
- branch, worktree, commit, and PR links;
- CI check summary;
- review/repair summary and remaining attempts;
- actionable errors and the exact command to resume or inspect.

Structured logs and journal events include timestamps, run/issue identifiers, operation names, outcomes, and sanitized error details. Secrets and full untrusted review bodies are excluded.

## Testing strategy

### Unit tests

- strict issue parser and field-level validation;
- native/body dependency normalization and mismatch detection;
- DAG construction, cycle detection, topological waves, and external blockers;
- issue and run state transitions;
- readiness and release gates;
- retry accounting;
- path, branch, and identifier sanitization;
- event replay and snapshot derivation.

### Integration tests

Use temporary Git repositories and fake GitHub/pi adapters to cover:

- worktree creation from the expected `origin/main` commit;
- concurrent workers with a configured limit;
- sibling failure isolation;
- PR creation reconciliation;
- cancelled-by-push versus genuinely failed CI;
- scoped repair and retry exhaustion;
- malicious or out-of-scope review text;
- crash followed by idempotent resume;
- divergence between journal and GitHub;
- lock contention;
- safe abort and cleanup.

### End-to-end tests

A local fixture repository exercises command registration and a complete fake run. The mandatory dry run is verified to cause no GitHub, branch, worktree, or worker mutation. A source-level and behavioral guard verifies that the package exposes no merge operation.

Live GitHub tests are optional and isolated from the default CI suite.

## Delivery phases

1. Package skeleton, domain types, strict parser, DAG, and tests.
2. Persistence, event replay, locking, and reconciliation core.
3. Git and GitHub adapters with contract tests.
4. Worker subprocess adapter and isolated worktree execution.
5. pi commands, dry-run approval, status UI, and skill.
6. PR/CI monitoring and bounded CI repair.
7. Review triage and bounded review repair.
8. Abort, cleanup, crash recovery, security hardening, and full E2E validation.

Each phase must leave a usable vertical slice and keep merge outside the package's capabilities.

## Success criteria

The design is successful when a user can select valid, explicitly linked GitHub issues; approve a deterministic wave plan; close pi during human review; later resume; and have only newly unblocked issues dispatched from an updated `origin/main`, without duplicate workers, branches, PRs, or side effects—and without the tool ever merging code.
