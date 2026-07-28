# Design: Safe Wave Planner

## Context

`pi-github-waves` will eventually coordinate GitHub issues through planning, worktree dispatch, pull-request monitoring, resume, and bounded repair. The approved program architecture is recorded in `docs/superpowers/architecture/2026-07-28-pi-github-waves-program-architecture.md`.

That program is too large for one implementation plan. This specification covers the first independently useful vertical slice: a read-only planner. It turns an explicit issue list into a validated dependency graph and dry run. It does not create branches or worktrees, start agents, or write to GitHub.

Later specifications will add, in order:

1. one-issue dispatch and durable state;
2. resumable DAG execution and human-merge release;
3. bounded CI/review repair;
4. recovery and security hardening.

Those later capabilities are context, not requirements of this slice.

## Goal

Provide a globally installable pi package with `/waves plan #3 #4 #6`. The command must deterministically validate the selected issues, recursively load their explicit blockers, reject unsafe or ambiguous input, calculate topological levels, and display a canonical dry run without external mutation.

## Non-goals

- `/waves run`, `resume`, `status`, dispatch, or repair.
- Git branches, worktrees, commits, pushes, PRs, comments, labels, or subprocess workers.
- Approval state or a durable run journal.
- Dependency inference.
- Ticket rewriting or LLM-based ticket-quality judgments.
- GitHub Enterprise Server.
- Project-controlled configuration, agents, or executable prompts.
- UI beyond ordinary pi command output and notifications.

## Package shape

The repository is `/Users/lucasborges/www/borges-lab/pi-github-waves` and is a pi package:

```text
package.json
extensions/
  github-waves/
    index.ts
src/
  domain/
    issue-spec.ts
    graph.ts
    plan.ts
  application/
    plan-wave.ts
  adapters/
    github-cli.ts
    git-cli.ts
  config/
    load-config.ts
  presentation/
    format-plan.ts
skills/
  github-waves/
    SKILL.md
test/
  fixtures/
```

The `pi` manifest exposes the extension and skill. Runtime dependencies belong in `dependencies`; pi core packages and `typebox` are peer dependencies with `"*"` ranges.

## Versioned constants

Protocol constants are exported from one module and included in plan output as `plannerSchemaVersion: 1`.

| Constant | Value |
|---|---:|
| Maximum selected issues | 50 |
| Maximum recursively loaded blocker issues | 200 |
| Maximum issue body bytes | 128 KiB UTF-8 |
| Maximum rendered errors per issue | 50 |
| Maximum command output bytes | 50 KiB UTF-8 |
| Maximum command output lines | 2,000 |
| Default maximum concurrency shown in plans | 3 |
| Allowed maximum concurrency | 1–8 |

Exceeding an input limit is a validation error. Rendered output is truncated only after the complete `PlanResult` has been computed; truncation reports omitted bytes/lines and writes the complete rendering to a temporary file.

## Configuration

The planner reads `~/.pi/agent/pi-github-waves.json` if present. Version 1 accepts exactly:

```json
{
  "schemaVersion": 1,
  "maxConcurrency": 3
}
```

Rules:

- absent file means `{ "schemaVersion": 1, "maxConcurrency": 3 }`;
- `schemaVersion` is required when the file exists and must equal `1`;
- `maxConcurrency` is optional and defaults to `3`;
- `maxConcurrency` must be an integer from 1 through 8;
- unknown keys, duplicate JSON keys, malformed JSON, symlinks, and files not owned by the current user are errors;
- the file must be a regular file no larger than 16 KiB;
- no environment variable or repository file overrides individual values.

Configuration is normalized to both fields before planning. Canonical JSON uses lexicographically sorted keys and no insignificant whitespace.

## Supported repository and authentication

The command runs inside a Git worktree. `GitPort.discover()` walks to the common repository and accepts one `origin` URL in any of these forms:

- `git@github.com:OWNER/REPO.git`;
- `ssh://git@github.com/OWNER/REPO.git`;
- `https://github.com/OWNER/REPO.git`.

Host matching is case-insensitive and must resolve to `github.com`; owner and repository names are normalized from the URL and validated against GitHub's allowed URL segment characters. Other hosts, multiple fetch URLs, missing `origin`, or a non-Git directory are errors.

The slice supports GitHub.com only. It invokes `gh auth status --hostname github.com` and read-only API calls. The authenticated user/token must be able to read repository metadata, issues, issue dependencies, timeline closing references, and pull-request metadata. No write permission is required or tested. A 401/403 is returned as an authentication/authorization error with the failing resource; no fallback scraping occurs.

The default branch comes from repository metadata returned by GitHub, never from a hard-coded name or local HEAD.

## Command grammar

The extension registers one command:

```text
/waves plan ISSUE...
```

Each argument must be `#N` or `N`, where `N` is a positive base-10 integer without a sign, decimal point, leading zero, repository prefix, range, or surrounding punctuation. Shell-style quoting is not interpreted because issue tokens cannot contain spaces.

Examples:

- valid: `/waves plan #3 4 #19`;
- invalid: `#0`, `#03`, `-3`, `owner/repo#3`, `#3,#4`, `3-5`.

At least one and at most 50 tokens are required. Duplicates are normalized to one issue and reported as warnings. Selected issues are sorted numerically in canonical results; input order is retained separately for display.

The command performs one planning pass and returns. It does not poll.

## Exact ticket grammar

The parser reads the GitHub issue body as UTF-8 Markdown. A body larger than 128 KiB fails validation.

### Required headings

Each section starts with an exact level-two ATX heading. Matching trims leading/trailing heading whitespace and is ASCII-case-insensitive. Closing `#` characters are not allowed. Headings inside fenced code blocks or block quotes are ignored.

Every issue must contain exactly one heading from each row:

| Canonical section | Accepted heading text |
|---|---|
| `context` | `Context`, `Contexto` |
| `objective` | `Objective`, `Objetivo` |
| `scope` | `Scope`, `Escopo` |
| `outOfScope` | `Out of scope`, `Fora de escopo` |
| `expectedBehavior` | `Expected behavior`, `Comportamento esperado` |
| `technicalNotes` | `Technical notes`, `Detalhes técnicos` |
| `acceptanceCriteria` | `Acceptance criteria`, `Critérios de aceite` |
| `testScenarios` | `Test scenarios`, `Cenários de teste` |
| `dependencies` | `Dependencies`, `Dependências` |

A section extends until the next level-two heading or end of body. Content may contain deeper headings. Every section must contain non-whitespace content after Markdown comments are removed. Duplicate aliases for the same canonical section are an error. Unknown level-two headings are allowed and ignored.

Acceptance criteria and test scenarios must each contain at least one top-level or nested unordered/ordered Markdown list item outside code fences and block quotes. Checkbox items count.

The parser reports errors as `{ issueNumber, code, section?, line?, message }` with stable machine codes.

### Eligibility

Every selected issue must:

- exist and be readable;
- be open, unless it already satisfies the completed-blocker rule below;
- have exactly one label named `agent: suitable`, compared case-insensitively;
- not have labels `agent: not suitable` or `agent: review required`, compared case-insensitively.

Boundary blockers need not have agent labels or pass the ticket-body contract because this planner will not dispatch them. Their bodies are read only to resolve fallback dependencies when native dependency data is absent.

Any error on a selected issue makes the whole `PlanResult` non-runnable. Valid selected siblings never form a partial runnable plan.

## Dependency grammar

The dependency declaration must be the only non-comment paragraph in the Dependencies section. It must be one of:

```text
Blocked by: #3, #4
Bloqueado por: #3, #4
None
Nenhuma
```

Rules:

- the key match is ASCII-case-insensitive;
- zero or more spaces are allowed around the colon and commas;
- one or more spaces/newlines may occur between tokens, but every separator must be a comma;
- references must be same-repository `#N` positive integers with no leading zeros;
- duplicate references are deduplicated and warned;
- self-reference is an error;
- cross-repository references, prose before/after the declaration, empty `Blocked by:`, trailing commas, and malformed tokens are errors;
- `None`/`Nenhuma` cannot be combined with references.

Canonical dependency arrays are unique and numerically sorted.

### Native versus body dependencies

For every selected or recursively discovered boundary issue:

1. Fetch native GitHub `blocked by` dependencies.
2. Parse the body declaration if the issue has the required Dependencies heading; for boundary issues without that heading, treat the fallback as absent rather than invalid.
3. If the native set is non-empty, use it. If the body set is also non-empty and differs, return `dependency_source_mismatch`.
4. If the native set is empty and a body declaration exists, use the body set.
5. If both are empty/absent, the issue has no blockers.

A native cross-repository dependency is rejected because the first version supports one repository graph.

### Recursive boundary traversal

Starting with selected issues, the planner breadth-first fetches every direct blocker, then every blocker's blockers, until no unseen blocker remains. It deduplicates by immutable GitHub node ID. The 200-boundary-node limit applies before fetching the next node; exceeding it fails the plan.

The complete reachable graph is used for cycle detection. A cycle anywhere reachable from a selected issue fails planning, including cycles composed only of boundary nodes. Boundary nodes are never added to the selected execution set.

## Completed-blocker rule

A selected or boundary issue is considered completed only when all of these hold:

1. the issue is closed;
2. GitHub's issue timeline contains at least one closing reference to a PR in the same repository;
3. that PR has non-null `mergedAt`;
4. its base branch equals the repository default branch; and
5. its merge commit OID is an ancestor of the current remote default-branch tip according to `git merge-base --is-ancestor` after a read-only `git fetch origin <default-branch>`.

The fetch updates remote-tracking refs but creates no branch, worktree, commit, or GitHub mutation. It is classified as a local Git metadata mutation and is disclosed in command output before execution. If strict zero-write operation is required, the user can cancel the command before the fetch confirmation described below.

Squash and rebase merges are accepted through the PR merge commit. If several closing PRs exist, any one satisfying all conditions completes the issue. Manual issue closure, a merged PR to another base, a closed-unmerged PR, or an unreachable merge commit does not complete it.

A selected completed issue is included as `completedPreexisting` and is not part of ready-wave calculations. An open selected issue must pass the ticket and label contract.

## Local-write confirmation

Planning requires a fetch to verify completed blockers. Before any fetch, the command displays the repository, default branch, and exact equivalent operation and asks:

> Planning may update local remote-tracking Git refs with a read-only `git fetch`. It will not change the working tree, branches, commits, or GitHub. Continue?

Declining returns a cancelled result and performs no local or remote mutation. After consent, the planner may update remote-tracking refs. It still performs no working-tree, branch, worktree, commit, push, or GitHub writes and starts no agent subprocess.

The phrase “mutation-free dry run” in this slice means no working-tree/content mutation and no remote/GitHub mutation; the disclosed fetch is the sole allowed local metadata write.

## Graph and wave semantics

The graph has directed edges `blocker -> blocked`. Completed nodes remain in the graph for explanation but do not contribute unresolved indegree.

The planner:

1. detects cycles in the full reachable graph with a deterministic node ordering;
2. removes completed nodes from unresolved-indegree calculations;
3. marks selected open issues with an unresolved boundary blocker as `blockedExternal`;
4. assigns topological levels to selected open issues whose selected predecessors can eventually complete;
5. defines level 1 as selected issues with no unresolved selected predecessor and no unresolved boundary blocker;
6. assigns each later selected issue `1 + max(level of selected blockers)` when all non-selected blockers are completed.

Levels are a visualization, not global barriers. The plan explicitly states that later execution will release each issue when its own blockers merge.

`maxConcurrency` does not change graph levels. The rendering groups each level into deterministic display batches of at most `maxConcurrency`, sorted by issue number, to estimate parallelism.

## Canonical data contracts

### Ports

```ts
interface GitHubReadPort {
  getRepository(): Promise<RepositorySnapshot>;
  getIssue(number: number): Promise<IssueSnapshot>;
  getBlockedBy(issueNodeId: string): Promise<DependencyRef[]>;
  getClosingPullRequests(issueNodeId: string): Promise<PullRequestSnapshot[]>;
}

interface GitReadPort {
  discover(): Promise<GitRepository>;
  fetchDefaultBranch(branch: string): Promise<{ tipOid: string }>;
  isAncestor(ancestorOid: string, descendantOid: string): Promise<boolean>;
}

interface ConfigPort {
  load(): Promise<PlannerConfigV1>;
}
```

All port methods either return the declared immutable value or throw a typed adapter error: `not_authenticated`, `forbidden`, `not_found`, `rate_limited`, `network`, `invalid_response`, `unsupported_repository`, or `git_failed`. Rate-limit errors include reset/retry metadata when supplied by GitHub. The planner does not retry in this slice.

### Plan result

```ts
interface PlanResultV1 {
  plannerSchemaVersion: 1;
  runnable: boolean;
  repository: {
    owner: string;
    name: string;
    remoteUrl: string;
    defaultBranch: string;
    defaultBranchTipOid: string;
  };
  config: { schemaVersion: 1; maxConcurrency: number };
  inputOrder: number[];
  selected: PlannedIssue[];
  boundary: PlannedBoundaryIssue[];
  edges: Array<{ blocker: number; blocked: number; source: "native" | "body" }>;
  levels: Array<{ level: number; batches: number[][] }>;
  warnings: ValidationMessage[];
  errors: ValidationMessage[];
  fingerprint: string;
}
```

`PlannedIssue` includes immutable node ID, number, title, URL, state, label names, `updatedAt`, body SHA-256, canonical dependencies, completion evidence, and disposition (`ready`, `blockedSelected`, `blockedExternal`, or `completedPreexisting`). Boundary entries include the same identity/dependency/completion fields but no ticket validation fields.

The fingerprint is SHA-256 over canonical JSON of the complete result excluding `fingerprint`, warnings, errors, and `inputOrder`. Object keys are lexicographically sorted; arrays retain declared semantic order, while every set-like array is sorted before construction. Timestamps use GitHub's normalized UTC RFC 3339 strings.

No plan is persisted in this slice. The result exists in the command response and full-output temporary file only. Therefore there is no “current plan” ambiguity or approval reconstruction yet.

## Adapter implementation constraints

`GitHubCliAdapter` invokes `gh` with executable/argument arrays and JSON output. It uses documented GitHub REST/GraphQL fields, never terminal-formatted text. Every response is schema-validated before conversion to snapshots.

`GitCliAdapter` invokes `git` with executable/argument arrays, never a shell string. It passes `--` where path ambiguity is possible and sets non-interactive environment variables. Stderr is bounded and sanitized.

The application layer owns traversal limits, validation aggregation, graph calculation, and fingerprinting. Adapters cannot decide eligibility or dependencies.

## Presentation

Successful output shows:

- repository and default-branch tip;
- selected issues and dispositions;
- validation warnings;
- boundary blockers and completion evidence;
- edges with source (`native` or `body`);
- cycles or validation errors;
- topological levels and concurrency display batches;
- canonical fingerprint;
- a statement that no execution occurred.

Errors are grouped by issue and stable error code. `runnable` is true only when there are no errors and every selected open issue is eligible and either ready or blocked only by selected work that can eventually complete. An unresolved external blocker makes the plan valid but `runnable: false` and is represented by an `external_blocker_open` error.

## Error handling

- Invalid command tokens fail before repository/API access.
- Invalid config fails before GitHub access.
- Unsupported repository or auth failure stops planning.
- 404 for a selected or blocker issue is an error; private inaccessible blockers are not treated as absent.
- Network, rate-limit, API-schema, fetch, or ancestry failures stop planning with a typed error and no partial `runnable` result.
- Ticket and graph validation collects all errors within input/traversal limits.
- Ctrl+C cancels in-flight `gh`/Git processes using the extension abort signal and returns cancelled.
- Temporary full-output files are mode `0600` and contain no credentials.

## Security

- No LLM participates in parsing, eligibility, dependency, completion, or graph decisions.
- Repository-controlled issue bodies are untrusted data and are never executed.
- No shell interpolation is used.
- No repository-controlled configuration, extension, skill, or agent is loaded by this package.
- The extension checks `ctx.isProjectTrusted()` before repository access, because pi project trust is required for project-local operation.
- Output sanitization strips control characters except newline and tab and bounds every field before rendering.
- This slice exposes no GitHub write operation and no Git operation other than discovery, fetch, and ancestry queries.

## Testing

### Unit tests

- command token grammar, duplicates, and limits;
- config defaults, canonicalization, ownership/symlink checks, and every invalid field;
- heading aliases, code fences, block quotes, duplicates, empty sections, list requirements, and size limits;
- every dependency grammar rule;
- native/body precedence and mismatch;
- recursive traversal, deduplication, limit, cross-repository edge, and boundary-only cycles;
- completed blocker cases: normal, squash, rebase, multiple PRs, manual close, wrong base, unreachable merge commit;
- graph levels, selected and external blockers, preexisting completion, concurrency batches, and deterministic ordering;
- canonical JSON and fingerprint stability;
- output truncation and control-character sanitization.

### Adapter contract tests

Fake executables placed first on `PATH` record argv and emit fixture JSON. Tests cover all supported remotes, auth failures, permissions, pagination, malformed API responses, rate limits, fetch failure, cancellation, and ancestry exit codes. Tests assert no shell use and no write-capable GitHub endpoint or Git command.

### Extension integration tests

A temporary Git repository and fake `gh`/`git` executables exercise:

- invalid args with zero external calls;
- declined fetch confirmation with zero mutation;
- valid mixed native/body recursive graph;
- invalid selected issue causing a non-runnable complete report;
- open external blocker;
- deterministic repeated output and fingerprint;
- output truncation to a mode-0600 file;
- successful command return after exactly one planning pass.

## Acceptance criteria

- The package is installable by local path with pi and exposes the `github-waves` skill and `/waves plan` command.
- A valid explicit issue set yields the canonical `PlanResultV1`, readable dry run, stable fingerprint, complete reachable blocker graph, and deterministic levels.
- Every parser, eligibility, dependency, completion, and graph decision is deterministic and tested without an LLM.
- Invalid or ambiguous input cannot yield `runnable: true`.
- The only permitted mutation is a disclosed, confirmed fetch of remote-tracking metadata.
- The slice cannot create or change GitHub content, working-tree files, local branches, worktrees, commits, pushes, PRs, or agent processes.
- Unit, adapter contract, and extension integration suites pass.
