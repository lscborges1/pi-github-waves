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

`src/graph/index.ts` exports the contracts and `buildDependencyWaveGraph`. Internal helpers are not exported. The module has no runtime dependencies and performs no I/O.

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
  schemaVersion: 1;
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
  | "invalid_issue_number"
  | "duplicate_node_id"
  | "duplicate_issue_number"
  | "duplicate_selected_id"
  | "selected_node_missing"
  | "selected_status_invalid"
  | "boundary_status_invalid"
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

Validation runs in this exact order. All safe errors in a row are collected; if a row emits errors, later rows do not run.

### Row 1: scalar values and limits

- `schemaVersion` must equal 1.
- `maxConcurrency` must be an integer from 1 through 8.
- Node IDs must be non-empty after ECMAScript `trim()`.
- Issue numbers must be positive safe integers.
- Selected IDs must be non-empty after `trim()`.
- Limits: at most 50 unique selected IDs, 200 non-selected nodes, and 10,000 input edges.

One error is emitted per invalid field. Limit errors emit once per exceeded limit.

### Row 2: identity and roles

- Node IDs are unique.
- Issue numbers are unique.
- Selected IDs are unique and resolve to nodes.
- Selected and boundary statuses follow the role table.

Duplicate errors emit once per duplicated value group regardless of group size. Missing selected IDs emit once per distinct missing ID. Status errors emit once per node.

### Row 3: edges

Edges are grouped by `(blockerId, blockedId)` and groups are sorted by resolved blocker number, resolved blocked number, blocker ID, then blocked ID.

Check precedence per group:

1. If either endpoint is missing, emit one `edge_endpoint_missing` and stop checking that group.
2. If blocker equals blocked, emit one `self_dependency` and stop checking that group.
3. If the group has more than one occurrence, emit one `duplicate_edge` error and stop checking that group.

This module treats duplicate edges as errors rather than warnings. No normalized graph is returned when any edge group fails.

### Row 4: closure

Traverse incoming edges from all selected nodes without completion barriers. Every boundary node must be reached. An unreachable boundary emits `boundary_status_invalid` with `details.reason = "unreachable"` once per node.

### Error ordering

Errors are sorted by:

1. `issueNumber: null` before numbered errors;
2. issue number ascending;
3. code in Unicode code-point order;
4. `details` serialized with keys in Unicode code-point order.

`details` keys are stable:

- duplicate IDs: `{ id }`;
- duplicate/malformed numbers: `{ issueNumber }` when representable;
- missing selected: `{ id }`;
- status: `{ status, role }`;
- endpoint: `{ blockerId, blockedId }`;
- limits: `{ actual, maximum }`;
- concurrency/schema: `{ actual, expected }`;
- unreachable boundary: `{ reason: "unreachable" }`.

## Completion barrier and relevant graph

Validation uses the unbarriered graph, but planning uses a relevant active graph:

1. Start at each selected node that is not `complete`.
2. For each direct incoming blocker:
   - include the blocker itself;
   - if the blocker is `complete`, stop that path;
   - otherwise continue through its incoming blockers.
3. Selected nodes with `complete` status remain in output but are not active roots.

A cycle entirely upstream of a complete blocker is irrelevant and is not reported. A cycle is relevant only if it exists in this active graph. Boundary output still contains every boundary input node; `relevant` records membership in the active graph.

All output edges are retained for explanation, including edges incident to complete or irrelevant nodes.

## Deterministic normalization

After validation:

- selected and boundary nodes sort by issue number, then ID;
- edges collapse is unnecessary because duplicates were rejected;
- output edges sort by blocker number, blocked number, blocker ID, blocked ID;
- every adjacency list uses ascending issue number, then ID;
- blocker-number arrays are unique ascending.

Input array order never affects output.

## Cycle detection

Run Tarjan's strongly connected components algorithm only on the relevant active graph.

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
3. In one reverse-topological pass, memoize whether each component reaches each fact.
4. Use memoized facts to classify selected nodes and responsible direct blockers.
5. For nodes surviving priorities 1–4, calculate levels in topological order.

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

A selection containing only `completed_preexisting` nodes is runnable with empty levels. An empty selection is structurally valid, returns a planned graph, and is not runnable.

## Immutability and failures

The implementation copies before sorting and never mutates input arrays or objects. It supports deeply frozen valid inputs.

Programmer violations outside declared TypeScript shapes may throw naturally. All graph-level errors listed in this specification return `invalid_input`.

## Testing

### Validation

Test every error code, validation-row short circuit, aggregation, ordering, and cardinality. Include 0/1/50/51 selected IDs, 200/201 boundary nodes, 10,000/10,001 edges, concurrency 1/8/9, duplicate groups of 2/3/4, overlapping edge failures, unreachable boundaries, and multiple errors in one row.

### Planning

Test empty graph, single ready, complete-only, chains, diamonds, disconnected selected components, selected invalid propagation, unresolved external propagation, mixed invalid/external precedence, direct blockers, transitive blockers, and completed barriers.

### Cycles

Test selected cycles, boundary cycles, selected-to-boundary cycles, cycle dependents, unaffected siblings, and cycles hidden upstream of completed barriers.

### Determinism and complexity

Property tests permute nodes, edges, and selected IDs and require deep-equal output. Instrument adjacency visits on large synthetic DAGs to assert a constant multiple of `V + E`, preventing per-selected full traversals.

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
