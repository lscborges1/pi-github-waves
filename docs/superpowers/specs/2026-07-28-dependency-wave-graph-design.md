# Design: Dependency Wave Graph

## Context

The `pi-github-waves` program has been decomposed because GitHub parsing, hostile runtime validation, canonical serialization, durable orchestration, workers, and repair are independently substantial modules. Their approved direction remains documented under `docs/superpowers/architecture/`.

This specification covers one narrow implementation plan: a pure, typed dependency-graph module. It receives normalized, trusted TypeScript values and calculates issue dispositions and display levels. It does not validate hostile JavaScript, parse Markdown, call GitHub/Git/pi, serialize canonical JSON, hash fingerprints, persist state, or execute work.

## Goal

Implement:

```ts
export function buildDependencyWaveGraph(
  input: DependencyGraphInput,
): DependencyGraphOutcome;
```

The function validates graph-level invariants, removes completed work as a dependency barrier, detects relevant cycles, propagates invalid and unresolved blockers, and calculates deterministic levels and concurrency display batches.

## Module boundary

```text
src/graph/
  contracts.ts
  validate-graph.ts
  strongly-connected.ts
  build-dependency-wave-graph.ts
  index.ts
test/graph/
  validate-graph.test.ts
  strongly-connected.test.ts
  build-dependency-wave-graph.test.ts
```

`src/graph/index.ts` and package exports expose only the contracts and `buildDependencyWaveGraph`. Helper files may use named source-level exports so repository tests can import them by relative source path; they are internal because they are absent from `index.ts` and the package `exports` map. The module has no runtime dependencies and performs no I/O.

### Internal seams

```ts
interface ValidatedGraph {
  schemaVersion: 1;
  maxConcurrency: number;
  selectedIds: string[];            // unique, raw, sorted by issue number then ID
  nodesById: ReadonlyMap<string, DependencyNode>;
  nodesByNumber: ReadonlyMap<number, DependencyNode>;
  nodes: DependencyNode[];           // issue number then ID
  edges: DependencyEdge[];           // blocker number, blocked number, IDs
  incoming: ReadonlyMap<string, readonly string[]>;
  outgoing: ReadonlyMap<string, readonly string[]>;
}

type GraphValidationOutcome =
  | { kind: "valid"; graph: ValidatedGraph }
  | { kind: "invalid"; errors: GraphError[] };

export function validateGraph(input: DependencyGraphInput): GraphValidationOutcome;

interface ActiveGraph {
  nodeIds: readonly string[];        // issue number then ID
  issueNumberById: ReadonlyMap<string, number>;
  outgoing: ReadonlyMap<string, readonly string[]>;
}

// ActiveGraph preconditions for the SCC helper:
// - nodeIds are unique and sorted by issue number then ID;
// - issueNumberById has exactly one entry for every nodeId and no extras;
// - outgoing has exactly one key for every nodeId, including empty arrays;
// - every neighbor belongs to nodeIds;
// - neighbor arrays are unique and sorted by issue number then ID;
// - no self-edge or duplicate edge exists.

interface GraphMetrics { nodeVisits: number; edgeVisits: number; }

interface StronglyConnectedResult {
  components: Array<{ nodeIds: string[]; cyclic: boolean }>;
  componentByNodeId: ReadonlyMap<string, number>;
}

export function findStronglyConnectedComponents(
  graph: ActiveGraph,
  metrics?: GraphMetrics,
): StronglyConnectedResult;
```

These helpers are source-level exports only. `validateGraph` returns all row-ordered errors and never a partial graph. `findStronglyConnectedComponents` requires an `ActiveGraph` satisfying every listed precondition; violating them is programmer error and may throw. It returns components sorted by their lowest issue number, with node IDs inside each component in issue-number/ID order. `componentByNodeId` contains every active node exactly once, no extras, and maps to the zero-based index of that node's component in the **final sorted** `components` array; indexes are remapped after sorting. `ActiveGraph.issueNumberById` supplies ordering context explicitly.

## Contracts

```ts
export const GRAPH_SCHEMA_VERSION = 1 as const;
export const MAX_SELECTED_NODES = 50;
export const MAX_BOUNDARY_NODES = 200;
export const MAX_EDGES = 10_000;

export type NodeStatus =
  | "complete"
  | "eligible"
  | "invalid"
  | "unresolved";

export interface DependencyNode {
  id: string;
  issueNumber: number;
  status: NodeStatus;
}

export interface DependencyEdge {
  blockerId: string;
  blockedId: string;
}

export interface DependencyGraphInput {
  schemaVersion: number;
  maxConcurrency: number;
  selectedIds: string[];
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export type SelectedDisposition =
  | "ready"
  | "blocked_selected"
  | "blocked_external"
  | "blocked_invalid_selected"
  | "completed_preexisting"
  | "invalid";

export interface PlannedSelectedNode {
  id: string;
  issueNumber: number;
  disposition: SelectedDisposition;
  level: number | null;
  directBlockerNumbers: number[];
  unresolvedBlockerNumbers: number[];
}

export interface PlannedBoundaryNode {
  id: string;
  issueNumber: number;
  status: "complete" | "unresolved";
  relevant: boolean;
}

export interface DependencyCycle {
  issueNumbers: number[];
}

export interface DependencyWaveGraph {
  schemaVersion: 1;
  runnable: boolean;
  selected: PlannedSelectedNode[];
  boundary: PlannedBoundaryNode[];
  edges: Array<{
    blockerId: string;
    blockerNumber: number;
    blockedId: string;
    blockedNumber: number;
  }>;
  cycles: DependencyCycle[];
  levels: Array<{ level: number; batches: number[][] }>;
}

export type GraphErrorCode =
  | "schema_version_unsupported"
  | "concurrency_out_of_range"
  | "selected_limit_exceeded"
  | "boundary_limit_exceeded"
  | "edge_limit_exceeded"
  | "invalid_node_id"
  | "invalid_selected_id"
  | "invalid_issue_number"
  | "duplicate_node_id"
  | "duplicate_issue_number"
  | "duplicate_selected_id"
  | "selected_node_missing"
  | "selected_status_invalid"
  | "boundary_status_invalid"
  | "unreachable_boundary_node"
  | "edge_endpoint_missing"
  | "self_dependency"
  | "duplicate_edge";

export interface GraphError {
  code: GraphErrorCode;
  issueNumber: number | null;
  details: Record<string, string | number>;
}

export type DependencyGraphOutcome =
  | { kind: "planned"; graph: DependencyWaveGraph }
  | { kind: "invalid_input"; errors: GraphError[] };
```

The input is trusted to have the declared object/array/primitive shapes. Passing values outside the TypeScript contract is programmer error and outside this module's behavior. Graph-level invalid values described below return `invalid_input` and do not throw.

## Input meaning

- `selectedIds` is the exact work set requested for future execution.
- Nodes not in `selectedIds` are boundary blockers and are never executable.
- Edges point `blocker -> blocked`.
- The caller supplies the full unbarriered blocker closure: following incoming edges from every selected node without stopping at completion reaches every non-selected node in `nodes`.
- `complete` means merge completion was already verified by an upstream module.
- `eligible` means selected work passed upstream ticket/label validation.
- `invalid` means selected work cannot execute.
- `unresolved` means boundary work is not verified complete.

Allowed status by role:

| Role | Allowed status |
|---|---|
| Selected | `complete`, `eligible`, `invalid` |
| Boundary | `complete`, `unresolved` |

## Graph-level validation

Validation runs in this exact order. Every check listed in the current row runs over the original input, using only facts that row declares valid. If a row emits any errors, later rows do not run. There is no within-row short circuit except the per-edge-group precedence in Row 3. This is the complete meaning of “collect errors”; no other inferred errors are emitted.

### Row 1: scalar values and limits

- `schemaVersion` must equal 1.
- `maxConcurrency` must be an integer from 1 through 8.
- Node IDs must be non-empty after ECMAScript `trim()`.
- Issue numbers must be finite positive safe integers. `NaN`, infinities, and negative zero are invalid.
- Selected IDs must be non-empty after ECMAScript `trim()`; failures use `invalid_selected_id`.

IDs remain raw opaque strings. `trim()` is used only for the emptiness predicate; valid values are never trimmed, case-folded, or Unicode-normalized before identity comparison or output.
- Limits: at most 50 unique selected IDs, 200 non-selected nodes, and 10,000 input edges.

First scan all nodes and record scalar validity by original node index. Emit one error per invalid node ID field and one per invalid issue-number field. Limits are computed independently and emit once per exceeded limit: selected count is distinct raw selected strings; boundary count is input nodes whose raw `id` is absent from that distinct raw-selected set; edge count is `edges.length`. If Row 1 has any error, duplicate/role resolution does not run.

### Row 2: identity and roles

- Node IDs are unique.
- Issue numbers are unique.
- Selected IDs are unique and resolve to nodes.
- Selected and boundary statuses follow the role table.

Row 2 computes duplicate node-ID and issue-number groups first, then still performs every other Row 2 check with ambiguity rules. A selected ID resolves uniquely only when it maps to exactly one node and that node's issue number maps to exactly one node. `duplicate_selected_id.issueNumber` is that unique number only under this rule; otherwise null. A selected ID mapping to zero nodes emits `selected_node_missing`; one mapping to multiple nodes is not also “missing.” Selected status is checked only for uniquely resolved selected nodes. Boundary status is checked only for nodes with unique ID and unique issue number; ambiguous nodes already have duplicate errors. Duplicate errors emit once per duplicated value group regardless of group size. Missing selected IDs emit once per distinct missing ID. Status errors emit once per safely attributable node.

### Row 3: edges

Edges are grouped by `(blockerId, blockedId)` and groups are sorted by resolved blocker number, resolved blocked number, blocker ID, then blocked ID.

Check precedence per group:

1. If either endpoint is missing, emit one `edge_endpoint_missing` and stop checking that group.
2. If blocker equals blocked, emit one `self_dependency` and stop checking that group.
3. If the group has more than one occurrence, emit one `duplicate_edge` error and stop checking that group.

This module treats duplicate edges as errors rather than warnings. No normalized graph is returned when any edge group fails.

### Row 4: closure

Traverse incoming edges from all selected nodes without completion barriers. Every boundary node must be reached. An unreachable boundary emits `unreachable_boundary_node` once per node.

### Exact error contract

Numeric detail values are normalized before constructing `GraphError`: finite non-negative-zero numbers remain numbers; `NaN`, `Infinity`, `-Infinity`, and `-0` become those exact strings. Original node indexes are zero-based.

| Code | Cardinality | `issueNumber` | Exact `details` |
|---|---|---:|---|
| `schema_version_unsupported` | once | null | `{ actual, expected: 1 }` |
| `concurrency_out_of_range` | once | null | `{ actual, expected: "integer 1..8" }` |
| `selected_limit_exceeded` | once | null | `{ actual, maximum: 50 }` |
| `boundary_limit_exceeded` | once | null | `{ actual, maximum: 200 }` |
| `edge_limit_exceeded` | once | null | `{ actual, maximum: 10000 }` |
| `invalid_node_id` | once per invalid field | valid unique issue number if Row-1-valid, else null | `{ nodeIndex, value: id }` |
| `invalid_selected_id` | once per invalid selected field | null | `{ selectedIndex, value: id }` |
| `invalid_issue_number` | once per invalid field | null | `{ nodeIndex, value: normalizedNumber }` |
| `duplicate_node_id` | once per duplicated valid ID group | null | `{ id }` |
| `duplicate_issue_number` | once per duplicated valid number group | duplicated number | `{ issueNumber }` |
| `duplicate_selected_id` | once per group | resolved node number, else null | `{ id }` |
| `selected_node_missing` | once per distinct missing ID | null | `{ id }` |
| `selected_status_invalid` | once per node | node number | `{ role: "selected", status }` |
| `boundary_status_invalid` | once per node | node number | `{ role: "boundary", status }` |
| `unreachable_boundary_node` | once per node | node number | `{ reason: "unreachable" }` |
| `edge_endpoint_missing` | once per exact edge group | resolved blocked number, else null | `{ blockedId, blockerId }` |
| `self_dependency` | once per endpoint pair | node number | `{ blockedId, blockerId }` |
| `duplicate_edge` | once per endpoint pair | blocked node number | `{ blockedId, blockerId, occurrences }` |

For `invalid_node_id`, issue-number uniqueness is evaluated among Row-1-valid issue numbers even though Row 2 will not run. Duplicate groups contain only Row-1-valid scalar values. Status values are contract literals.

Errors are sorted by:

1. `issueNumber: null` before numbered errors;
2. issue number ascending;
3. code in Unicode code-point order;
4. stable details string.

The stable details string sorts keys by Unicode code-point order and joins `key=value` pairs with `;`. Stable details strings are compared lexicographically by Unicode code-point order. Number values use base-10 `String(value)` and strings use `JSON.stringify(value)`. All numeric details have already been normalized, so this serialization never receives non-finite numbers.

## Completion barrier and relevant graph

Validation uses the unbarriered graph, but planning uses a relevant active graph:

1. Start at each selected node that is not `complete`; add it to `relevantNodes`.
2. For each incoming edge to a relevant non-complete node, add that edge to `relevantEdges` and add its blocker to `relevantNodes`.
3. If that blocker is `complete`, do not inspect any of its incoming edges. Otherwise continue recursively.
4. Selected nodes with `complete` status remain in output but are not relevant roots.
5. Define `activeNodes` as relevant nodes whose status is not `complete`.
6. Define `activeEdges` as relevant edges whose blocker and blocked endpoints are both in `activeNodes`.

Tarjan and all propagation use exactly `(activeNodes, activeEdges)`. An edge into a complete blocker is never added because traversal stops before inspecting that blocker's incoming edges; an edge out of a complete blocker may be relevant for explanation but is excluded from `activeEdges`. A cycle entirely upstream of a complete blocker is irrelevant and is not reported. A cycle is relevant only if it exists in this active graph. Boundary output still contains every boundary input node; `relevant` records membership in the active graph.

All output edges are retained for explanation, including edges incident to complete or irrelevant nodes.

## Deterministic normalization

After validation, all ID tie-breaks use one shared `compareOpaqueId(a, b)`: return 0 when equal; otherwise return -1 when ECMAScript `a < b` is true and 1 otherwise. This is lexicographic UTF-16 code-unit order, performs no locale comparison or normalization, and is used everywhere this spec says “then ID.”

- selected and boundary nodes sort by issue number, then ID;
- edges collapse is unnecessary because duplicates were rejected;
- output edges sort by blocker number, blocked number, blocker ID, blocked ID;
- every adjacency list uses ascending issue number, then ID;
- blocker-number arrays are unique ascending.

Input array order never affects output.

## Cycle detection

Run Tarjan's strongly connected components algorithm only on `(activeNodes, activeEdges)`.

A component is cyclic when it has more than one node. Self-edges were rejected during validation. Each cycle output contains unique ascending issue numbers. Cycles sort lexicographically by their numeric arrays.

A selected node is cycle-affected when it belongs to a cycle or reaches a cycle by repeatedly following incoming blocker edges in the active graph. Cycle-affected selected nodes classify `invalid`.

## Classification precedence

Classify selected nodes by ascending issue number using first match:

| Priority | Condition | Disposition | Level |
|---:|---|---|---|
| 1 | Selected status is `invalid`, or node is cycle-affected | `invalid` | null |
| 2 | Selected status is `complete` | `completed_preexisting` | null |
| 3 | Active blocker closure contains an invalid selected node | `blocked_invalid_selected` | null |
| 4 | Active blocker closure contains an unresolved boundary node | `blocked_external` | null |
| 5 | No incomplete selected direct blocker | `ready` | 1 |
| 6 | Otherwise | `blocked_selected` | `1 + max(level of incomplete selected direct blockers)` |

Cycle-affected nodes match priority 1 themselves. Therefore priority 3 propagates only selected nodes invalid because of input status, not cycle invalidity; downstream cycle dependents are already cycle-affected.

Invalid-selected takes precedence over external blocking. External blocking takes precedence over ordinary selected blocking.

## Blocker fields

`directBlockerNumbers` contains every direct incoming blocker number, including completed and irrelevant blockers, unique ascending.

`unresolvedBlockerNumbers`:

- `completed_preexisting`: empty;
- `invalid`: direct blockers that are not complete;
- `blocked_invalid_selected`: direct blockers whose active upstream closure includes a status-invalid selected node;
- `blocked_external`: direct blockers whose active upstream closure includes an unresolved boundary node;
- `ready`: empty;
- `blocked_selected`: incomplete selected direct blockers.

A direct blocker is included in its own closure before traversing farther upstream.

## Efficient propagation

Do not run a full DFS for each selected issue.

1. Condense relevant active strongly connected components into a DAG.
2. Mark component-local facts: cycle, status-invalid selected, unresolved boundary.
3. Iterate condensation components in ordinary topological order for `blocker -> blocked` edges. For each component, union fact flags from its incoming predecessor (blocker) components with its local facts. This propagates upstream blocker facts downstream.
4. Use memoized incoming facts to classify selected nodes and responsible direct blockers.
5. For nodes surviving priorities 1–4, calculate levels in the same topological direction.

After deterministic sorting, graph work is `O(V + E)`.

## Levels and batches

Only `ready` and `blocked_selected` nodes appear in levels.

- Levels are consecutive beginning at 1.
- Issue numbers within a level are ascending.
- Each level is partitioned consecutively into non-empty batches of at most `maxConcurrency`.

Example for level numbers `[3, 4, 8, 9, 10]` and concurrency 3: `[[3, 4, 8], [9, 10]]`.

Batches estimate parallelism; they are not runtime barriers.

## Runnable

`runnable` is true exactly when:

- there are no relevant cycles;
- no selected node is `invalid`, `blocked_invalid_selected`, or `blocked_external`; and
- at least one selected node exists.

A selection containing only `completed_preexisting` nodes is runnable with empty levels. Empty `selectedIds` with empty `nodes` is structurally valid, returns a planned non-runnable empty graph, and has empty levels. Empty `selectedIds` with any nodes fails Row 4 because every node is an unreachable boundary.

## Immutability and failures

The implementation copies before sorting and never mutates input arrays or objects. It supports deeply frozen valid inputs.

Programmer violations outside declared TypeScript shapes may throw naturally. All graph-level errors listed in this specification return `invalid_input`.

## Testing

### Validation

Test every error code, validation-row short circuit, aggregation, ordering, and cardinality. Golden Row 2 fixtures include a duplicated node ID also duplicated in `selectedIds`, duplicated issue numbers on distinct IDs, missing selected IDs, and mixed role-status failures; they assert exact null/number attribution. Include 0/1/50/51 selected IDs, 200/201 boundary nodes, 10,000/10,001 edges, concurrency 1/8/9, duplicate groups of 2/3/4, overlapping edge failures, unreachable boundaries, and multiple errors in one row.

### Planning

Test empty selection with empty nodes as planned/non-runnable, empty selection with non-empty nodes as unreachable-boundary invalid input, single ready, complete-only, chains, diamonds, disconnected selected components, selected invalid propagation, unresolved external propagation, mixed invalid/external precedence, direct blockers, transitive blockers, and completed barriers.

### Cycles

Test selected cycles, boundary cycles, selected-to-boundary cycles, cycle dependents, unaffected siblings, and cycles hidden upstream of completed barriers. A direct SCC-helper golden fixture asserts final sorted components and remapped `componentByNodeId` indexes.

### Determinism and complexity

Property tests permute nodes, edges, and selected IDs and require deep-equal output.

`build-dependency-wave-graph.ts` has this named source-level export, absent from `index.ts` and package exports:

```ts
export function buildDependencyWaveGraphInternal(
  input: DependencyGraphInput,
  metrics?: GraphMetrics,
): DependencyGraphOutcome;
```

The public `buildDependencyWaveGraph(input)` returns exactly `buildDependencyWaveGraphInternal(input)` with no metrics; outcomes are otherwise identical. `metrics` is a test-only mutable `{ nodeVisits: number; edgeVisits: number }`. A test caller must initialize both counters to zero. The internal function does not reset them and accumulates increments into the supplied object.

Metrics cover planning after successful validation and sorting, not validation or sort comparisons. `V = nodes.length` and `E = edges.length` in the validated input.

- Relevant discovery: increment node once per dequeued node and edge once per inspected incoming edge.
- Tarjan: increment node once when first entering a node and edge once per outgoing edge examined.
- Condensation: increment node by a component's node count when processing that component and edge once per original active edge consumed.
- Topological propagation: increment node by component node count when processing it and edge once per condensation edge consumed.
- Classification: increment node once per selected node; increment edge once per direct incoming edge consulted.
- Level construction: increment node once per included selected node and edge once per selected-blocker relation consulted.

No other operation increments metrics. Synthetic DAG tests assert both final counters separately are at most `12 * (V + E)`, starting from zero. This generous fixed bound detects per-selected traversals without constraining constant-pass implementation details.

### Immutability

Deep-freeze fixtures and compare deep clones before and after calls.

## Implementation plan

This specification maps to one plan:

1. contracts and row-ordered graph validation;
2. deterministic normalization and relevant-graph construction;
3. Tarjan condensation and memoized propagation;
4. classification, levels, batches, and runnable calculation;
5. validation, planning, cycle, property, complexity, and immutability tests.

No task may introduce runtime-shape validation, adapters, serialization, hashing, filesystem access, or pi APIs.

## Acceptance criteria

- The public module exports only contracts and `buildDependencyWaveGraph`.
- Every graph-level invalid input returns stable ordered errors and no partial graph.
- Every valid input returns all selected and boundary nodes, all edges, relevant cycles, deterministic dispositions, levels, batches, and runnable.
- Completed nodes are dependency barriers for cycle/blocker propagation.
- Input permutations produce deep-equal output.
- Inputs are never mutated.
- Graph processing is linear after sorting.
- The module performs no I/O and has no runtime dependencies.
- All specified tests pass.
