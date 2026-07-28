# Design: Deterministic Wave Planner Core

## Context

`pi-github-waves` is decomposed into separately planned modules because the complete product includes GitHub/Git adapters, pi commands, durable execution, workers, reconciliation, and repairs.

The approved program architecture is in:

- `docs/superpowers/architecture/2026-07-28-pi-github-waves-program-architecture.md`
- `docs/superpowers/architecture/2026-07-28-safe-wave-planner-architecture.md`

This specification covers only the first implementation unit: a pure TypeScript domain module that receives already normalized issue and dependency snapshots and returns a deterministic wave plan. It performs no Markdown parsing, configuration loading, filesystem access, process execution, Git, GitHub, pi registration, persistence, or rendering.

## Goal

Implement a framework-independent `planWaves(input)` function with explicit data contracts. Given a complete reachable issue graph, precomputed eligibility/completion observations, and diagnostics from future adapters, it must validate structural invariants, detect cycles, classify every selected issue, calculate display levels and concurrency batches, and produce canonical JSON plus a stable fingerprint.

## Non-goals

- Parsing issue bodies or dependency declarations.
- Fetching or validating GitHub data.
- Verifying PR merges or Git ancestry.
- Loading user configuration.
- Registering `/waves` commands or skills.
- Approvals, runs, journals, worktrees, workers, CI, reviews, or repairs.
- Retrying or recovering external operations.

## Module boundary

Files introduced by this unit:

```text
src/domain/
  contracts.ts
  diagnostics.ts
  validate-input.ts
  graph.ts
  canonical-json.ts
  plan-waves.ts
src/domain/index.ts
test/domain/
  validate-input.test.ts
  graph.test.ts
  canonical-json.test.ts
  plan-waves.test.ts
```

`src/domain/index.ts` exports only the contracts, `planWaves`, and `canonicalizePlan`. Internal graph helpers are not public.

The module depends only on the JavaScript standard library and Node's `crypto` implementation for SHA-256. It accepts immutable values and does not mutate input objects or arrays.

## Protocol constants

```ts
export const PLANNER_SCHEMA_VERSION = 1 as const;
export const MAX_SELECTED_ISSUES = 50;
export const MAX_BOUNDARY_ISSUES = 200;
export const MAX_DEPENDENCIES_PER_ISSUE = 100;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
```

Limits are applied to unique normalized entries. Exceeding a limit returns an invalid-input outcome; data is not silently truncated.

## Input contract

```ts
export type IssueState = "OPEN" | "CLOSED";
export type NodeAvailability = "available" | "missing" | "unreadable";
export type Eligibility = "eligible" | "invalid" | "not_required";
export type CompletionStatus = "complete" | "incomplete" | "unknown";
export type DependencySource = "native" | "body";

export interface SourceDiagnostic {
  code: string;
  severity: "error" | "warning";
  issueNumber: number | null;
  message: string;
}

export interface CompletionObservation {
  status: CompletionStatus;
  closingPullRequestNumbers: number[];
  verifiedMergeCommitOids: string[];
}

export interface PlannerNodeV1 {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  availability: NodeAvailability;
  state: IssueState | null;
  updatedAt: string | null;
  bodySha256: string | null;
  eligibility: Eligibility;
  completion: CompletionObservation;
  sourceDiagnostics: SourceDiagnostic[];
}

export interface PlannerEdgeV1 {
  blockerNodeId: string;
  blockedNodeId: string;
  source: DependencySource;
}

export interface PlannerInputV1 {
  plannerSchemaVersion: 1;
  repository: {
    nodeId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    defaultBranchTipOid: string;
  };
  config: { maxConcurrency: number };
  inputOrder: number[];
  selectedNodeIds: string[];
  nodes: PlannerNodeV1[];
  edges: PlannerEdgeV1[];
  sourceDiagnostics: SourceDiagnostic[];
}
```

### Input semantics

The caller must provide the complete dependency closure reachable from selected nodes. Every dependency edge is `blocker -> blocked`. `selectedNodeIds` identifies work requested by the user; all other nodes are boundary blockers.

Future adapters determine availability, eligibility, completion, and source diagnostics. The core never second-guesses those observations. It does validate their internal consistency.

`nodeId`, repository `nodeId`, and OIDs are opaque non-empty strings. The core does not assume a GitHub ID format.

## Structural validation

Validation runs before graph calculation and collects all errors that can be found safely. It returns stable diagnostics rather than throwing for user/data errors.

### Stable core diagnostic codes

```ts
export type CoreErrorCode =
  | "schema_version_unsupported"
  | "selected_limit_exceeded"
  | "boundary_limit_exceeded"
  | "dependency_limit_exceeded"
  | "concurrency_out_of_range"
  | "duplicate_node_id"
  | "duplicate_issue_number"
  | "duplicate_selected_node_id"
  | "selected_node_missing"
  | "input_order_mismatch"
  | "edge_endpoint_missing"
  | "duplicate_edge_conflict"
  | "self_dependency"
  | "node_state_inconsistent"
  | "completion_inconsistent"
  | "eligibility_inconsistent"
  | "dependency_cycle";
```

Core warnings use:

```ts
export type CoreWarningCode = "duplicate_edge";
```

### Invariants

- `plannerSchemaVersion` must equal `1`.
- `maxConcurrency` must be an integer from 1 through 8.
- Node IDs and issue numbers are unique. Issue numbers are positive safe integers.
- Selected IDs are unique, exist in `nodes`, and number at most 50.
- `inputOrder` contains exactly the selected issue numbers once each; order may differ from canonical order.
- Non-selected nodes number at most 200.
- Every edge endpoint exists.
- A node has at most 100 unique incoming blockers.
- Self-edges are invalid.
- Duplicate edges with the same endpoints and source produce one warning and collapse to one edge.
- Duplicate edges with the same endpoints but different sources produce `duplicate_edge_conflict`; the core does not choose a source.
- `availability !== "available"` requires `state`, `updatedAt`, and `bodySha256` to be `null`, `eligibility: "invalid"`, and `completion.status: "unknown"` with empty evidence.
- `completion.status: "complete"` requires `state: "CLOSED"`, at least one closing PR number, at least one verified merge OID, and `eligibility: "not_required"`.
- `completion.status: "incomplete"` requires an available node and cannot use `eligibility: "not_required"`.
- `completion.status: "unknown"` requires empty completion evidence.
- A selected, available, incomplete node must have `eligibility: "eligible"` or `"invalid"`.
- A boundary node may use `eligibility: "not_required"` regardless of incomplete completion because it is never dispatched.
- A selected complete node must use `eligibility: "not_required"`.
- Source diagnostics are carried through. Any source error attached to a selected node makes it invalid. Any source error attached to a boundary node makes that boundary unresolved. Global source errors make the plan non-runnable.

If any structural invariant except a graph cycle fails, graph classification is skipped because the graph is not trustworthy. The outcome is `invalid_input` with no plan or fingerprint.

## Output contract

```ts
export type SelectedDisposition =
  | "ready"
  | "blocked_selected"
  | "blocked_external"
  | "blocked_invalid_selected"
  | "completed_preexisting"
  | "invalid";

export interface PlannedSelectedIssueV1 {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  disposition: SelectedDisposition;
  level: number | null;
  directBlockerNumbers: number[];
  unresolvedBlockerNumbers: number[];
  diagnostics: SourceDiagnostic[];
}

export interface PlannedBoundaryIssueV1 {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  completionStatus: CompletionStatus;
  diagnostics: SourceDiagnostic[];
}

export interface PlanDiagnostic {
  code: string;
  severity: "error" | "warning";
  issueNumber: number | null;
  message: string;
  cycleIssueNumbers?: number[];
}

export interface WavePlanV1 {
  plannerSchemaVersion: 1;
  runnable: boolean;
  repository: PlannerInputV1["repository"];
  config: PlannerInputV1["config"];
  inputOrder: number[];
  selected: PlannedSelectedIssueV1[];
  boundary: PlannedBoundaryIssueV1[];
  edges: Array<{
    blockerNodeId: string;
    blockerNumber: number;
    blockedNodeId: string;
    blockedNumber: number;
    source: DependencySource;
  }>;
  levels: Array<{ level: number; batches: number[][] }>;
  diagnostics: PlanDiagnostic[];
  fingerprint: string;
}

export type PlannerOutcome =
  | { kind: "planned"; plan: WavePlanV1 }
  | { kind: "invalid_input"; diagnostics: PlanDiagnostic[] };
```

No method throws for contract violations, source errors, or cycles. Programmer errors from unavailable platform primitives such as a missing SHA-256 implementation may throw because they indicate a broken runtime, not invalid planning data.

## Graph normalization

After structural validation:

1. Copy nodes into maps by node ID and issue number.
2. Collapse exact duplicate edges.
3. Sort nodes by issue number, then node ID.
4. Sort edges by blocker issue number, blocked issue number, then source.
5. Build adjacency and reverse-adjacency lists in that same order.

All graph algorithms iterate only these sorted structures. API/input array order cannot influence output other than the preserved `inputOrder` display field.

## Cycle handling

Tarjan's strongly connected components algorithm runs over the full graph, including completed and boundary nodes. A component is cyclic when it has more than one node; self-edges were already rejected structurally.

For each cyclic component, emit one `dependency_cycle` error. `cycleIssueNumbers` contains unique issue numbers sorted ascending. Cycle diagnostics are sorted by their first issue number, then lexicographically by the entire numeric sequence.

A graph containing any cycle returns `kind: "planned"` with:

- `runnable: false`;
- every selected node in or transitively dependent on a cycle classified `invalid`;
- unaffected selected nodes classified normally;
- cyclic or cycle-dependent selected nodes omitted from `levels`;
- a valid fingerprint covering this non-runnable plan.

This differs from structural invalidity because the graph remains well-formed and useful to display.

## Classification rules

Classification is performed in ascending selected issue-number order.

### Terminal complete

A selected node with `completion.status: "complete"` is `completed_preexisting`, has `level: null`, and has no unresolved blockers. Its incoming dependencies remain in output for explanation but do not block dependents.

### Invalid selected

A selected node is `invalid` when any applies:

- availability is missing or unreadable;
- eligibility is invalid;
- it has a source error;
- it belongs to or transitively depends on a cycle.

Invalid nodes have `level: null`.

### Blocked by invalid selected

An otherwise valid selected node is `blocked_invalid_selected` when any transitive selected blocker is invalid. It has `level: null`; `unresolvedBlockerNumbers` contains the direct blockers that lead to invalid selected work, sorted ascending.

This rule takes precedence over external and ordinary selected blocking.

### Blocked externally

An otherwise valid selected node is `blocked_external` when any transitive boundary blocker is not complete or has a source error. It has `level: null`; `unresolvedBlockerNumbers` contains direct blockers that lead to unresolved boundary work, sorted ascending.

This rule takes precedence over ordinary selected blocking.

### Ready and blocked selected

For remaining valid, incomplete selected nodes, completed direct blockers are ignored.

- If no incomplete selected blocker remains, disposition is `ready` and level is `1`.
- Otherwise disposition is `blocked_selected` and level is `1 + max(level of its incomplete selected blockers)`.

Because invalid/cyclic/external cases were removed first, each remaining selected blocker has a level. `unresolvedBlockerNumbers` contains incomplete direct selected blocker numbers.

A node may have `disposition: "blocked_selected"` at level 1 only if all direct selected blockers are completed, which means it is actually `ready`; therefore `blocked_selected` always has level 2 or greater.

## Runnable rule

`runnable` is true exactly when:

- there is no global source error;
- there is no cycle;
- no selected issue is `invalid`, `blocked_invalid_selected`, or `blocked_external`; and
- at least one selected issue is `ready`, `blocked_selected`, or `completed_preexisting`.

A plan containing only completed-preexisting selected issues is runnable and has no levels; presentation layers may report it as already complete. Source warnings never change runnable status.

## Levels and batches

`levels` includes only `ready` and `blocked_selected` issues. Entries are grouped by their calculated level in ascending order. Issue numbers within a level are ascending.

Each level's numbers are partitioned consecutively into batches of at most `maxConcurrency`. For numbers `[3, 4, 8, 9, 10]` and concurrency `3`, batches are `[[3, 4, 8], [9, 10]]`.

Batches estimate display parallelism only. They do not imply a global runtime barrier.

## Diagnostics

Source diagnostics are copied and never rewritten. Core diagnostics use the stable codes in this document.

Canonical diagnostic ordering:

1. `issueNumber: null` before numbered issues;
2. issue number ascending;
3. severity `error` before `warning`;
4. code by Unicode code-point order;
5. message by Unicode code-point order;
6. cycle sequence lexicographically when present.

Messages are developer-facing English constants generated from deterministic templates. Fingerprinting excludes diagnostic messages and includes only diagnostic code, severity, issue number, and cycle numbers so wording changes do not alter identity.

## Canonicalization and fingerprint

`canonicalizePlan(plan)` returns UTF-8 JSON with:

- object keys recursively sorted by Unicode code-point order;
- no insignificant whitespace;
- `null` retained;
- no `undefined`, non-finite numbers, negative zero, bigint, symbol, function, Map, Set, or Date values;
- strings preserved exactly as supplied; normalization is an adapter responsibility;
- arrays retained in their contract-defined canonical order.

Before canonicalization:

- selected and boundary arrays sort by issue number, then node ID;
- edges sort as defined under graph normalization;
- direct/unresolved blocker arrays are unique numeric ascending;
- levels and batches sort as defined above;
- closing PR numbers numeric ascending;
- merge OIDs Unicode code-point ascending;
- diagnostics sort as defined above.

The fingerprint is lowercase hexadecimal SHA-256 of canonical JSON for the plan with:

- `fingerprint` set to the empty string;
- `inputOrder` excluded;
- diagnostic `message` fields excluded.

The returned plan contains that fingerprint. Calling `planWaves` repeatedly with semantically equivalent, differently ordered input must return byte-identical canonical plans except for preserved `inputOrder`; fingerprints must be identical.

## Example

Input graph:

```text
#3 ─┐
    ├─> #6 ─> #8
#4 ─┘
#20 (boundary, complete) ─> #8
```

All selected nodes are eligible and incomplete; boundary #20 is complete; concurrency is 2.

Expected classification:

```json
{
  "selected": [
    { "number": 3, "disposition": "ready", "level": 1 },
    { "number": 4, "disposition": "ready", "level": 1 },
    { "number": 6, "disposition": "blocked_selected", "level": 2 },
    { "number": 8, "disposition": "blocked_selected", "level": 3 }
  ],
  "levels": [
    { "level": 1, "batches": [[3, 4]] },
    { "level": 2, "batches": [[6]] },
    { "level": 3, "batches": [[8]] }
  ]
}
```

The complete output also includes identities, edges, diagnostics, repository data, and fingerprint.

## Error handling

- Structural validation aggregates deterministic errors and returns `invalid_input`; it never returns a partial plan.
- Cycles return a complete non-runnable plan.
- Source errors return a complete plan when structure remains valid.
- Inputs are copied before sorting; frozen inputs are supported.
- The function has no cancellation or retry behavior because it performs no I/O.
- Complexity is `O(V + E)` after canonical sorting; sorting is `O(V log V + E log E)`.

## Testing

### Contract validation

Cover every invariant and stable diagnostic code, including multiple simultaneous violations, boundary values (0/1/50/51 selected, 200/201 boundary, 100/101 blockers, concurrency 1/8/9), duplicate edge warning versus source conflict, missing endpoints, and inconsistent completion/eligibility states.

### Graph behavior

Cover chains, diamonds, disconnected components, completed blockers, selected completion, unresolved boundaries, invalid selected blockers, transitive invalid/external blockers, self-edge rejection, selected cycles, boundary-only cycles, cycle dependents, and unaffected siblings.

### Determinism

Property tests permute nodes, edges, selected IDs, source diagnostics, labels represented in source messages, PR evidence, and OIDs. Equivalent inputs must produce equal dispositions, levels, canonical ordering, and fingerprints. `inputOrder` may differ in returned plans but not fingerprints.

### Immutability

Deep-freeze representative inputs and assert planning succeeds without mutation. Compare a deep clone before and after every fixture.

### Golden fixtures

Commit canonical JSON fixtures for:

- simple ready plan;
- three-level diamond;
- completed preexisting selection;
- unresolved external blocker;
- invalid selected blocker with transitive dependent;
- mixed cycle plus unaffected component;
- warnings-only runnable plan.

## Implementation plan boundaries

This specification maps to one implementation plan with four ordered tasks:

1. contracts, constants, and structural validation;
2. deterministic graph normalization, cycle detection, and classification;
3. canonicalization and fingerprinting;
4. unit, property, immutability, and golden-fixture tests plus public exports.

No task may introduce adapters, Markdown, config files, pi APIs, or process execution.

## Acceptance criteria

- `planWaves` and `canonicalizePlan` are the only behavioral public exports.
- Every structurally valid input yields a complete `WavePlanV1`, including non-runnable source/cycle cases.
- Every structurally invalid input yields `invalid_input` with stable ordered diagnostics and no plan.
- Classification, levels, batches, diagnostics, canonical JSON, and fingerprints follow this specification exactly.
- Equivalent input permutations yield the same fingerprint.
- Inputs are never mutated.
- The module performs no I/O and has no runtime dependency beyond Node standard APIs.
- All contract, graph, determinism, immutability, and golden-fixture tests pass.
