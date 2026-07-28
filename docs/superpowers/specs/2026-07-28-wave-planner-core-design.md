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
  | "invalid_identifier"
  | "invalid_issue_number"
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
  | "completion_evidence_invalid"
  | "eligibility_inconsistent"
  | "source_diagnostic_misattached"
  | "dependency_cycle";
```

Core warnings use:

```ts
export type CoreWarningCode =
  | "duplicate_edge"
  | "duplicate_completion_evidence";
```

### Invariants and validation phases

Validation runs in three deterministic phases.

**Phase 1 — identity and limits:** schema, concurrency, array limits, non-empty identifiers, positive issue numbers, and duplicate node IDs/numbers. Repository node ID, owner, name, default branch, tip OID, every node ID, title, and URL must be non-empty strings after no trimming or normalization; whitespace-only strings are invalid. Issue numbers and completion PR numbers must be positive safe integers. If Phase 1 has errors, validation returns all Phase 1 errors and warnings and does not inspect selected references or edges, because duplicate identity makes attribution unsafe.

**Phase 2 — node and selection consistency:** selected IDs are unique, exist, and number at most 50. `inputOrder` contains exactly their issue numbers once each. An available node requires non-null `state`, `updatedAt`, and `bodySha256`. An unavailable node requires those fields to be null, `eligibility: "invalid"`, `completion.status: "unknown"`, and empty completion evidence.

Completion evidence is normalized by deduplicating and sorting PR numbers numerically and OIDs by Unicode code-point order. Duplicate evidence emits one `duplicate_completion_evidence` warning per node and kind. Every OID must be a non-empty, non-whitespace string. `complete` requires `state: "CLOSED"`, at least one PR number, at least one OID, and `eligibility: "not_required"`. `unknown` requires empty evidence. A selected available incomplete node requires `eligibility: "eligible"` or `"invalid"`. A boundary available incomplete node may use `eligible`, `invalid`, or `not_required`. A selected complete node requires `not_required`.

A diagnostic in `node.sourceDiagnostics` must have `issueNumber === node.number`; otherwise emit `source_diagnostic_misattached`. A diagnostic in top-level `input.sourceDiagnostics` must have `issueNumber === null`; otherwise emit the same code. Attached errors affect only their owning node; top-level errors are global. If Phase 2 has structural errors, validation returns all Phase 1 warnings plus all Phase 2 errors/warnings and does not inspect edges.

**Phase 3 — edges:** every endpoint exists; self-edges are invalid; at most 100 unique incoming blockers are allowed. Exact duplicates emit one warning and collapse. Same endpoints with different sources emit `duplicate_edge_conflict` and neither edge is chosen. If Phase 3 has errors, validation returns all warnings and Phase 3 errors with no graph.

All diagnostics safe within a phase are aggregated. Later phases never run after an earlier phase error. Warnings discovered before failure remain in the `invalid_input` outcome. Any structural error returns `invalid_input` with no plan or fingerprint. Graph cycles are not structural and are handled below.

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
  completion: CompletionObservation;
  diagnostics: SourceDiagnostic[];
}

export interface PlannedBoundaryIssueV1 {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  completion: CompletionObservation;
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

`planWaves` never throws for contract violations, source errors, or cycles. Programmer errors from unavailable platform primitives such as a missing SHA-256 implementation may throw because they indicate a broken runtime, not invalid planning data. `canonicalizePlan` has the exact signature `canonicalizePlan(plan: WavePlanV1): string`; it accepts only a plan produced by `planWaves` and throws `TypeError` for prohibited JavaScript values. That throw is a programmer-contract failure, not user/data validation.

## Graph normalization

After structural validation:

1. Copy nodes into maps by node ID and issue number.
2. Collapse exact duplicate edges.
3. Sort nodes by issue number, then node ID.
4. Sort edges by blocker issue number, blocked issue number, then source.
5. Build adjacency and reverse-adjacency lists in that same order.

All graph algorithms iterate only these sorted structures. API/input array order cannot influence output other than the preserved `inputOrder` display field.

## Effective completion, cycles, and traversal

A node is **effectively complete** only when `completion.status === "complete"` and it has no attached source error. Effective completion is a traversal barrier: all incident edges remain in output for explanation, but graph analysis removes the node and its incident edges. Therefore dependencies of completed work cannot propagate cycles, invalidity, or blocking to downstream work.

A complete node with an attached source error is not effectively complete. A selected such node is invalid; a boundary such node is unresolved.

Tarjan's strongly connected components algorithm runs over the remaining active graph. A component is cyclic when it has more than one node; self-edges were already rejected structurally. For each cyclic component, emit one `dependency_cycle` error with unique ascending `cycleIssueNumbers`.

A graph containing a cycle remains structurally useful and returns `kind: "planned"`. Selected nodes in a cycle or transitively dependent on one through active blocker edges are invalid. Unaffected components classify normally. Cyclic/cycle-dependent selected nodes have no level. The plan is non-runnable and receives a valid fingerprint.

Every transitive blocker search walks incoming active edges in ascending blocker-number order and stops at effectively complete nodes. This traversal rule applies identically to cycle dependency, invalid-selected propagation, and unresolved-boundary propagation.

## Classification rules and precedence

Classification is performed in ascending selected issue-number order with this first-match precedence:

| Priority | Condition | Disposition | Level |
|---:|---|---|---|
| 1 | Own availability/eligibility/source error, or belongs to/transitively depends on active cycle | `invalid` | `null` |
| 2 | Effectively complete | `completed_preexisting` | `null` |
| 3 | Transitively blocked by invalid selected work through active edges | `blocked_invalid_selected` | `null` |
| 4 | Transitively blocked by unresolved boundary work through active edges | `blocked_external` | `null` |
| 5 | No incomplete selected blocker | `ready` | `1` |
| 6 | Otherwise | `blocked_selected` | `1 + max(blocker levels)` |

An invalid selected node is one whose availability is missing/unreadable, eligibility is invalid, attached source diagnostics contain an error, or active dependency closure reaches a cycle. A boundary node is unresolved when it is not effectively complete; an attached source error is therefore unresolved.

`blocked_invalid_selected` takes precedence when both invalid selected and external blockers exist. `blocked_external` takes precedence over ordinary selected blocking. For level calculation, all remaining blockers are valid selected nodes with defined levels.

### Blocker output fields

For every selected disposition, `directBlockerNumbers` is all direct incoming blocker issue numbers from normalized output edges, including completed blockers, unique and ascending.

`unresolvedBlockerNumbers` is unique and ascending and follows this exhaustive mapping:

- `completed_preexisting`: empty;
- `invalid`: direct blockers that are not effectively complete;
- `blocked_invalid_selected`: direct blockers from which an invalid selected node or active cycle is reachable without crossing effective completion;
- `blocked_external`: direct blockers from which an unresolved boundary node is reachable without crossing effective completion;
- `ready`: empty;
- `blocked_selected`: direct, incomplete, valid selected blockers.

`blocked_selected` always has level 2 or greater. A selected node whose selected blockers are all effectively complete is `ready`.

`plan.boundary` always contains **every** non-selected input node exactly once, sorted by issue number then node ID, regardless of whether classification later finds it relevant.

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

`plan.diagnostics` contains, exactly once, every top-level source diagnostic, every node-attached source diagnostic, every core warning, and every cycle diagnostic. `PlannedSelectedIssueV1.diagnostics` and `PlannedBoundaryIssueV1.diagnostics` contain only source diagnostics attached to that node; global and core diagnostics are not copied into nodes. Structural misattachment prevents a plan, so a planned result cannot contain an attached diagnostic for another issue.

Core messages and issue-number attribution are fixed:

| Code | `issueNumber` | Exact message template |
|---|---|---|
| `schema_version_unsupported` | null | `Unsupported planner schema version: {value}.` |
| `selected_limit_exceeded` | null | `Selected issue limit exceeded: {count} > 50.` |
| `boundary_limit_exceeded` | null | `Boundary issue limit exceeded: {count} > 200.` |
| `dependency_limit_exceeded` | blocked issue | `Dependency limit exceeded for issue #{n}: {count} > 100.` |
| `concurrency_out_of_range` | null | `maxConcurrency must be an integer from 1 through 8: {value}.` |
| `invalid_identifier` | node issue when known, otherwise null | `Invalid non-empty identifier for {field}: {jsonValue}.` |
| `invalid_issue_number` | null | `Issue number must be a positive safe integer: {jsonValue}.` |
| `duplicate_node_id` | null | `Duplicate node ID: {jsonString}.` |
| `duplicate_issue_number` | duplicated number | `Duplicate issue number: #{n}.` |
| `duplicate_selected_node_id` | selected issue when resolvable, otherwise null | `Duplicate selected node ID: {jsonString}.` |
| `selected_node_missing` | null | `Selected node ID is missing from nodes: {jsonString}.` |
| `input_order_mismatch` | null | `inputOrder must contain each selected issue number exactly once.` |
| `edge_endpoint_missing` | blocked issue when resolvable, otherwise null | `Edge endpoint is missing: {blockerJson} -> {blockedJson}.` |
| `duplicate_edge_conflict` | blocked issue | `Edge sources conflict for #{blocker} -> #{blocked}.` |
| `self_dependency` | node issue | `Issue #{n} depends on itself.` |
| `node_state_inconsistent` | node issue | `Node state fields are inconsistent for issue #{n}.` |
| `completion_inconsistent` | node issue | `Completion status is inconsistent for issue #{n}.` |
| `completion_evidence_invalid` | node issue | `Completion evidence is invalid for issue #{n}: {field}.` |
| `eligibility_inconsistent` | node issue | `Eligibility is inconsistent for issue #{n}.` |
| `source_diagnostic_misattached` | owning node issue when attached, otherwise null | `Source diagnostic issueNumber is inconsistent with its container.` |
| `dependency_cycle` | lowest cycle issue | `Dependency cycle: {ascendingNumbersJoinedByArrow}.` |
| `duplicate_edge` | blocked issue | `Duplicate edge collapsed: #{blocker} -> #{blocked} ({source}).` |
| `duplicate_completion_evidence` | node issue | `Duplicate completion evidence collapsed for issue #{n}: {field}.` |

`{jsonValue}` and `{jsonString}` use `JSON.stringify`; values that cannot be JSON-stringified render their JavaScript type name. Counts use base-10 integers. These templates live in `diagnostics.ts` and golden tests assert exact output.

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
