# Safe Wave Planner Design

## Summary

The safe planner is the first read-only vertical slice over the existing dependency-wave graph core. It adds `/waves plan ISSUE...` to a current pi package, reads GitHub.com through `gh`, validates selected issues deterministically, verifies completed blockers without changing local refs, and renders one durable textual plan entry in the pi session.

The graph core under `src/graph/` is frozen for this slice. Planning translates trusted snapshots into its existing `DependencyGraphInput` and enriches the resulting dispositions for presentation.

## Scope and constraints

- Accept 1 through 50 arguments in exact `N` or `#N` form; positive base-10 integers have no sign, leading zero, range, repository prefix, or punctuation. Duplicate numbers are deduplicated with stable warnings.
- Support trusted worktrees whose single `origin` fetch URL resolves to GitHub.com. Discover repository identity with read-only Git commands and default branch metadata with GitHub.
- Use GitHub native issue dependencies as the only edge source. Dependencies must remain in the same repository.
- Load at most 200 distinct boundary blockers breadth-first in issue-number order. Stop before loading dependencies above a verified completion barrier.
- Use a fixed display concurrency of 3. This slice has no configuration file, fingerprint, approved plan, run journal, worker, fetch, or GitHub write.
- Target Node.js 22.19 or newer. Compile and test against `@earendil-works/pi-coding-agent@0.84.2` and `@earendil-works/pi-tui@0.84.2`; publish both as pi-required `"*"` peer dependencies.
- Reuse `MAX_SELECTED_NODES`, `MAX_BOUNDARY_NODES`, and `MAX_EDGES` from the graph package. Never duplicate their numeric values in planning code.

## Architecture

### Units

- **Command parser** converts raw slash-command arguments into a canonical issue selection or an `invalid_command` fatal outcome.
- **Ticket parser** parses CommonMark with `mdast-util-from-markdown`. It validates exact level-two English or Portuguese headings and never interprets prose semantically.
- **Planning application** owns traversal, eligibility, completion classification, graph translation, diagnostics, and deterministic ordering. It depends only on `RepositoryPort` and `GitHubReadPort`.
- **Repository adapter** discovers the worktree, common directory, and `origin` through `git` argument arrays. It performs no fetch or mutation.
- **GitHub adapter** invokes `gh api` with argument arrays, validates every response from `unknown` with Zod, paginates dependencies, and translates external failures to typed adapter errors.
- **Presentation adapter** registers `/waves plan`, checks project trust, records progress, and appends one TUI-only session entry with a bounded textual renderer.

### Data flow

1. Parse and canonicalize issue arguments before external calls.
2. Require `ctx.isProjectTrusted()` and discover a supported GitHub.com `origin`.
3. Verify `gh` authentication and load repository identity, default branch, and its current tip OID.
4. Traverse selected issues and blockers breadth-first. For each issue, load its snapshot and closing events, verify completion, and either stop at the completion barrier or load native blockers.
5. Validate every non-complete selected issue. It must be open, include `agent: suitable`, exclude `agent: not suitable` and `agent: review required`, and satisfy the ticket-body contract.
6. Translate selected issues to `eligible`, `invalid`, or `complete`; translate boundary blockers to `unresolved` or `complete`; invoke `buildDependencyWaveGraph` without changing the core.
7. Convert core cycles, blocked-external dispositions, and validation outcomes into stable diagnostics, then render the complete read model.

## Ticket contract

Every executable selected issue contains exactly one accepted heading from each row. The UTF-8 body size is measured with `Buffer.byteLength(body, "utf8")` and must not exceed 128 KiB.

| Canonical section | English | Portuguese |
|---|---|---|
| `context` | Context | Contexto |
| `objective` | Objective | Objetivo |
| `scope` | Scope | Escopo |
| `outOfScope` | Out of scope | Fora de escopo |
| `expectedBehavior` | Expected behavior | Comportamento esperado |
| `technicalNotes` | Technical notes | Detalhes técnicos |
| `acceptanceCriteria` | Acceptance criteria | Critérios de aceite |
| `testScenarios` | Test scenarios | Cenários de teste |

The parser uses the CommonMark AST plus original source lines with these exact rules:

- A section heading is a root-level ATX heading beginning with zero through three spaces, exactly two `#` characters, and at least one following space. Setext headings, nested headings, headings with closing `#` sequences, and headings inside block quotes or code are not section headings.
- An accepted heading contains text children only. Their values are joined, trimmed with ECMAScript `trim()`, and compared by ASCII lower-casing only. Inline emphasis, links, code, or other child nodes make that heading unknown.
- A section extends from its accepted heading until the next root-level ATX level-two heading, accepted or unknown, or end of body.
- For emptiness only, remove root-level `html` nodes whose entire value matches a complete HTML comment. Nested comments and unterminated comments remain content. Remaining root nodes must contain non-whitespace source text.
- List evidence is any `listItem` descendant of a root-level `list` node in that section. Lists nested under block quotes or other containers do not count.
- Duplicate accepted English/Portuguese aliases for one canonical section emit one `duplicate_section`; a missing section, empty section, and missing list evidence each emit their own stable diagnostic when attributable.

Label eligibility normalizes each label by trimming ASCII whitespace (`TAB`, `LF`, `FF`, `CR`, and space) and ASCII lower-casing. An executable selected issue must contain normalized `agent: suitable` and contain neither `agent: not suitable` nor `agent: review required`. Output labels are the unique normalized values in UTF-16 code-unit order.

Issue text is untrusted display data and is never executed or sent to a model.

## Completion and graph semantics

An issue is complete only when it is currently closed and at least one GraphQL `ClosedEvent` in the current closure epoch has a pull request closer that:

- is merged with non-null `mergedAt` and `mergeCommitOid`;
- targets the repository's current default branch; and
- has a merge commit that is identical to or an ancestor of the current default-branch tip according to GitHub's commit-comparison API.

Manual closure, a wrong-base PR, an unmerged PR, a missing merge OID, or a diverged/unreachable merge commit is not completion evidence. A verified complete issue remains explanatory output but its own dependencies are not loaded.

The adapter preserves GraphQL connection order across pages. The current closure epoch begins at the connection position immediately after the final `ReopenedEvent`; when no reopen exists it begins at the first returned event. Only `ClosedEvent` nodes at or after that position can establish completion. Timestamps are explanatory data and never determine epoch ordering, so equal timestamps are unambiguous.

Closing/reopening events are fetched chronologically through a connection containing only `ClosedEvent` and `ReopenedEvent`, 100 nodes per page, with a hard limit of 1,000 events. A remaining page after 1,000 events is a fatal `resource_limit` outcome; the adapter never silently misses possible completion evidence.

`maxConcurrency: 3` affects display batches only. Waves are explanatory levels, never global scheduling barriers.

## Contracts and failures

The internal contracts are exact:

```ts
type TicketSection =
  | "context" | "objective" | "scope" | "outOfScope"
  | "expectedBehavior" | "technicalNotes"
  | "acceptanceCriteria" | "testScenarios";

type PlanDiagnosticCode =
  | "duplicate_input" | "issue_missing" | "issue_unreadable"
  | "issue_closed_uncompleted" | "label_missing" | "label_conflict"
  | "body_too_large" | "missing_section" | "duplicate_section"
  | "empty_section" | "missing_list_item"
  | "dependency_cross_repository" | "boundary_limit_exceeded"
  | "edge_limit_exceeded" | "dependency_cycle" | "external_blocker_open";

interface PlanDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: PlanDiagnosticCode;
  readonly issueNumber: number | null;
  readonly section: TicketSection | null;
  readonly line: number | null;
  readonly details: Readonly<Record<string, string | number>>;
}

interface CompletionEvidence {
  readonly completed: boolean;
  readonly pullRequests: readonly {
    readonly number: number;
    readonly url: string;
    readonly mergedAt: string;
    readonly mergeCommitOid: string;
    readonly baseBranch: string;
    readonly reachable: boolean;
  }[];
}

interface DiscoveredRepository {
  readonly worktreeRoot: string;
  readonly commonDir: string;
  readonly originUrl: string;
  readonly owner: string;
  readonly name: string;
}

interface RemoteRepositorySnapshot {
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly defaultBranchTipOid: string;
}

interface IssueSnapshot {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
}

interface DependencySnapshot {
  readonly repositoryUrl: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly issueNodeId: string;
  readonly number: number;
}

interface PullRequestCloserSnapshot {
  readonly nodeId: string;
  readonly repositoryNodeId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly url: string;
  readonly mergedAt: string | null;
  readonly mergeCommitOid: string | null;
  readonly baseBranch: string;
}

type ClosureEventSnapshot =
  | { readonly kind: "reopened"; readonly nodeId: string; readonly createdAt: string }
  | { readonly kind: "closed"; readonly nodeId: string; readonly createdAt: string; readonly closer: PullRequestCloserSnapshot | null };

interface ClosureEventPage {
  readonly events: readonly ClosureEventSnapshot[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface DependencyPage {
  readonly dependencies: readonly DependencySnapshot[];
  readonly page: number;
  readonly hasNextPage: boolean;
}

interface CommitComparisonSnapshot {
  readonly status: "ahead" | "behind" | "diverged" | "identical";
}

interface PlannedIssueV1 {
  readonly number: number;
  readonly nodeId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: "OPEN" | "CLOSED" | null;
  readonly labels: readonly string[];
  readonly updatedAt: string | null;
  readonly completion: CompletionEvidence;
  readonly graphNode: PlannedSelectedNode | null;
}

interface PlannedBoundaryIssueV1 {
  readonly number: number;
  readonly nodeId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: "OPEN" | "CLOSED" | null;
  readonly updatedAt: string | null;
  readonly completion: CompletionEvidence;
  readonly graphNode: PlannedBoundaryNode | null;
}

interface PlanResultV1 {
  readonly plannerSchemaVersion: 1;
  readonly repository: {
    readonly nodeId: string;
    readonly owner: string;
    readonly name: string;
    readonly url: string;
    readonly defaultBranch: string;
    readonly defaultBranchTipOid: string;
  };
  readonly inputOrder: readonly number[];
  readonly maxConcurrency: 3;
  readonly selected: readonly PlannedIssueV1[];
  readonly boundary: readonly PlannedBoundaryIssueV1[];
  readonly edges: readonly { readonly blockerNumber: number; readonly blockedNumber: number }[];
  readonly graph: DependencyWaveGraph | null;
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly runnable: boolean;
}

type FatalCode =
  | "invalid_command" | "project_untrusted" | "unsupported_repository"
  | "not_authenticated" | "forbidden" | "rate_limited" | "network"
  | "timeout" | "resource_limit" | "invalid_response" | "process_failed";

type CommandOutcome =
  | { readonly kind: "planned"; readonly plan: PlanResultV1 }
  | { readonly kind: "fatal"; readonly code: FatalCode; readonly message: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: "cancelled"; readonly message: string };
```

`runnable` is exactly `graph?.runnable === true` and no `error` diagnostic. `graph` is null when issue/dependency completeness is unknown or a planning limit prevents constructing the full safe input. Invalid ticket/label/closed-uncompleted selected issues still enter a complete graph input with status `invalid`, so their graph disposition remains visible.

`inputOrder` contains the first occurrence of each valid issue number in command order; duplicates do not appear twice. Selected and boundary arrays sort by issue number, edges by blocker then blocked number, completion pull requests by PR number then node ID, and normalized labels by UTF-16 code-unit order. The embedded graph retains its existing deterministic ordering.

Diagnostics sort by severity (`error` before `warning`), issue number (`null` first, then ascending), code in UTF-16 code-unit order, section (`null` first), line (`null` first), then a stable details serialization with sorted keys. Duplicate input warnings use the duplicated issue number. No diagnostic stores raw issue text. Details are exact by code:

| Code | Details |
|---|---|
| `duplicate_input` | `{ occurrences }` |
| `issue_missing` | `{ resource: "issue" }` |
| `issue_unreadable` | `{ resource: "issue" | "dependencies" | "closure" }` |
| `issue_closed_uncompleted` | `{ state: "CLOSED" }` |
| `label_missing` | `{}` |
| `label_conflict` | `{ labels }`, comma-joined normalized conflicting labels |
| `body_too_large` | `{ actualBytes, maximumBytes }` |
| `missing_section` | `{}` |
| `duplicate_section` | `{ occurrences }` |
| `empty_section` | `{}` |
| `missing_list_item` | `{}` |
| `dependency_cross_repository` | `{ owner, repository }` |
| `boundary_limit_exceeded` | `{ parentIssueNumber, attemptedTotal, maximum }` |
| `edge_limit_exceeded` | `{ parentIssueNumber, attemptedTotal, maximum }` |
| `dependency_cycle` | `{ issueNumbers }`, comma-joined ascending numbers |
| `external_blocker_open` | `{ blockerNumbers }`, comma-joined ascending numbers |

Failure mapping is fixed:

- Selected issue 404 emits `issue_missing`; selected 403/410 emits `issue_unreadable`. A selected issue's dependency or closure endpoint returning 404/403/410 emits `issue_unreadable` with the matching resource.
- Boundary issue 404/403/410, or the same statuses from its dependency/closure endpoint, emits `issue_unreadable` for that boundary.
- Any reportable unreadable/missing issue makes `graph` null because blocker closure is unknown; the result remains `planned` and non-runnable with all safely collected snapshots.
- A dependency that names another repository emits `dependency_cross_repository`, adds no edge/node for that reference, stops traversal, and makes `graph` null.
- When one parent's sorted unseen boundary set would exceed `MAX_BOUNDARY_NODES`, add none of that parent's new nodes, emit `boundary_limit_exceeded` with `{ parentIssueNumber, attemptedTotal, maximum }`, stop traversal, and return `graph: null`.
- When one parent's unique edge set would exceed `MAX_EDGES`, add none of that parent's new edges, emit `edge_limit_exceeded` with the same atomic behavior, stop traversal, and return `graph: null`.
- A core `invalid_input` outcome is a fatal `invalid_response`, because only validated adapters/application code construct graph input; its individual internal errors are logged sanitized and are not exposed as ticket diagnostics.
- Compare `mergeCommitOid` as the base and `defaultBranchTipOid` as the head. Status `identical` or `ahead` means reachable; `behind` or `diverged` means unreachable. Comparison 404/409, malformed comparison status, incomplete pagination, and other failures that make completion unknowable are fatal `invalid_response`; network, rate limit, authentication, authorization, timeout, and process failures retain their corresponding fatal codes.
- Ticket and graph-domain failures aggregate inside a non-runnable planned result. Fatal outcomes never include partial plan data.

All subprocess output is bounded. Response headers are whitelisted before logging; tokens, authorization headers, issue bodies, complete responses, and PII are never logged. User-facing messages contain stable codes and sanitized context rather than raw adapter internals.

The exact ports are:

```ts
interface RepositoryPort {
  discover(cwd: string): Promise<DiscoveredRepository>;
}

interface GitHubReadPort {
  authenticate(): Promise<void>;
  getRepository(owner: string, name: string): Promise<RemoteRepositorySnapshot>;
  getIssue(owner: string, name: string, number: number): Promise<IssueSnapshot>;
  getBlockedBy(owner: string, name: string, number: number, page: number): Promise<DependencyPage>;
  getClosureEvents(owner: string, name: string, number: number, cursor: string | null): Promise<ClosureEventPage>;
  compareCommits(owner: string, name: string, baseOid: string, headOid: string): Promise<CommitComparisonSnapshot>;
}
```

Native dependencies use only `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by?per_page=100&page=N`, with `X-GitHub-Api-Version: 2026-03-10`. The adapter uses a constant `--jq` projection to emit only `repository_url`, issue `node_id`, and issue number, then validates that projected array with Zod. It parses the canonical API repository URL into validated owner/name fields before application use; this permits a stable `dependency_cross_repository` diagnostic without another lookup. `DependencyPage.hasNextPage` is `dependencies.length === 100`; the application requests numeric pages starting at 1 and stops on a shorter page. It may request page 3 only to prove the 200-boundary limit was exceeded, after which atomic limit behavior applies.

Closure events use GraphQL cursor pagination because their endpoint is a connection. A closer is considered only when `repositoryNodeId`, owner, and repository name all match the planned repository in addition to its base branch matching the default branch.

Supported `origin` forms are exactly `git@github.com:OWNER/REPO.git`, `ssh://git@github.com/OWNER/REPO.git`, and `https://github.com/OWNER/REPO.git`. Host comparison is ASCII case-insensitive. Reject other schemes/hosts, non-`git` SSH users, URL credentials, query/fragment data, extra path segments, empty owner/repository, multiple fetch URLs, missing origin, and non-worktrees.

GitHub calls send `X-GitHub-Api-Version: 2026-03-10`. Each subprocess has a 30-second timeout, a 2 MiB stdout cap, and a 64 KiB stderr cap. Exceeding a cap is fatal `resource_limit`. Only HTTP status, `Retry-After`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` may survive header parsing; every other header and raw body is discarded after Zod conversion.

## Presentation

For every trusted, syntactically valid command invocation, the extension appends exactly one durable `waves-plan` entry that is excluded from model context, whether the outcome is planned, fatal, or cancelled. Invalid command and untrusted-project rejection happen before planning and produce one error notification with no entry. Progress status is always cleared in `finally`.

The persisted entry payload is exactly `{ schemaVersion: 1, kind, text, truncated }`, where `text` is already bounded and sanitized. It never persists `PlanResultV1`, issue bodies, raw responses, headers, tokens, or adapter error causes. The entry renderer displays only this payload.

Planned text shows repository/default tip, selected dispositions, boundary completion state, edges, cycles, waves/batches, diagnostics, and the explicit statement `No execution occurred.` Fatal and cancelled text shows only the stable outcome code/message and the same no-execution statement; fatal adapter internals are excluded.

Rendering is capped at 50 KiB UTF-8 and 2,000 lines. Truncation reports omitted content and writes no temporary file. The structured result remains the source for deterministic rendering.

## Testing and acceptance

- Unit tests cover command grammar, ticket headings and aliases, empty/duplicate/list failures, labels, limits, ordering, sanitization, traversal, barriers, graph translation, and all completion cases.
- Fake-port tests prove breadth-first traversal, invariance to adapter response order, no partial runnable plan, and stable diagnostics.
- Fake `git`/`gh` executables cover argv, pagination, HTTP/error translation, malformed responses, timeouts, and cancellation. Tests reject every write-capable GitHub endpoint and mutating Git command.
- Extension integration tests cover registration, trust rejection, progress cleanup, durable entry creation, renderer bounds, and repeated deterministic output.
- `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm pack --dry-run` pass. A temporary `pi -e .` smoke test loads the package without persistent installation.

## Deferred work

Configuration, fingerprints, approval, durable runs, dispatch, status APIs, web UI, IPC, and macOS code are deferred. Issue #11 follows durable journal/snapshot/status work; Issue #12 follows a stable local read protocol and begins as a read-only companion.
