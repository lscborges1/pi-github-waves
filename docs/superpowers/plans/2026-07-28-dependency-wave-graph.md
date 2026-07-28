# Dependency Wave Graph Implementation Plan

> **Scope:** Implement only the pure dependency-graph module specified in `docs/superpowers/specs/2026-07-28-dependency-wave-graph-design.md`. Do not add GitHub/Git adapters, Markdown parsing, pi commands, persistence, serialization, hashing, worktrees, or workers.

**Goal:** Build a deterministic, immutable TypeScript graph planner that validates normalized issue graphs, applies completion barriers, detects relevant cycles, propagates blocker states, and calculates display waves.

**Architecture:** `validateGraph` converts a typed input into sorted maps/adjacency or stable errors. Relevant-graph construction applies completion barriers. Tarjan condenses the active graph, then one topological pass propagates invalid/external/cycle facts. The public wrapper returns deterministic dispositions, levels, and batches without I/O.

**Tech stack:** Node 22, TypeScript, Vitest, fast-check, pnpm.

**Authoritative spec:** `docs/superpowers/specs/2026-07-28-dependency-wave-graph-design.md`

## Global constraints

- Use pnpm only.
- Follow red-green-refactor for every behavioral task.
- Keep graph logic under `src/graph/`.
- Export publicly only from `src/graph/index.ts` and package `./graph`.
- Source-level helper exports are allowed for repository tests but must not enter package exports.
- Never mutate caller-owned values; tests must exercise deeply frozen inputs.
- Input IDs remain raw opaque strings. Use the shared ECMAScript relational comparator; never trim, normalize, case-fold, or locale-sort valid IDs.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm build` before each task commit.

---

## Task 1: Scaffold the TypeScript library and contracts

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `src/graph/contracts.ts`
- Create: `src/graph/index.ts`
- Create: `test/graph/contracts.test.ts`

### Steps

1. Create a minimal ESM package named `pi-github-waves` with:
   - runtime dependency list empty;
   - dev dependencies `typescript`, `vitest`, `fast-check`, and `@types/node`;
   - scripts `test`, `test:watch`, `typecheck`, and `build`;
   - package export `./graph` pointing to `dist/graph/index.js` and its declarations.
2. Configure strict TypeScript, NodeNext modules, declarations, `src` as build root, and `dist` as output.
3. Write a compile-time/public-surface test that imports every contract from `src/graph/index.ts` and verifies no helper implementation is exported.
4. Run the test first and confirm failure because contracts do not exist.
5. Implement the exact constants, input/output contracts, error codes, and public function declaration from the spec. The function may temporarily throw `Not implemented`; no behavior is claimed yet.
6. Run:

   ```bash
   pnpm test test/graph/contracts.test.ts
   pnpm typecheck
   pnpm build
   ```

7. Commit:

   ```bash
   git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts src/graph/contracts.ts src/graph/index.ts test/graph/contracts.test.ts
   git commit -m "chore: scaffold dependency graph library"
   ```

---

## Task 2: Implement row-ordered graph validation

**Files:**

- Create: `src/graph/compare.ts`
- Create: `src/graph/validate-graph.ts`
- Create: `test/graph/validate-graph.test.ts`
- Modify: `src/graph/index.ts`

### Interfaces

Implement the source-level helper:

```ts
export function validateGraph(
  input: DependencyGraphInput,
): GraphValidationOutcome;
```

`validateGraph` is imported directly by repository tests but is not re-exported from `src/graph/index.ts`.

### Steps

1. Write failing tests for Row 1:
   - unsupported schema;
   - concurrency 1/8 accepted and 0/9/non-integer rejected;
   - empty/whitespace node and selected IDs;
   - invalid issue numbers including `NaN`, infinities, and negative zero;
   - selected/boundary/edge limits;
   - exact errors, normalized number details, and ordering.
2. Implement `compareOpaqueId` using the spec's ECMAScript relational comparison and Row 1 validation. Do not mutate or normalize IDs.
3. Write failing tests for Row 2:
   - duplicate ID/number groups of 2/3/4;
   - duplicated selected IDs with unambiguous and ambiguous node identity;
   - missing selections;
   - selected and boundary status rules;
   - exact null/number attribution;
   - short-circuiting after Row 1.
4. Implement Row 2 and the exact error table.
5. Write failing tests for Row 3:
   - missing endpoints;
   - self-dependencies;
   - duplicates;
   - overlapping failures and precedence;
   - dependency ordering.
6. Implement Row 3 grouping and precedence.
7. Write failing tests for Row 4:
   - complete unbarriered closure;
   - unrelated boundary nodes;
   - empty selection with empty/non-empty nodes.
8. Implement closure validation and construct `ValidatedGraph` with sorted nodes, edges, incoming, and outgoing maps.
9. Add deep-freeze tests proving validation does not mutate inputs.
10. Run:

    ```bash
    pnpm test test/graph/validate-graph.test.ts
    pnpm typecheck
    pnpm build
    ```

11. Commit:

    ```bash
    git add src/graph/compare.ts src/graph/validate-graph.ts test/graph/validate-graph.test.ts src/graph/index.ts
    git commit -m "feat: validate normalized dependency graphs"
    ```

---

## Task 3: Build the relevant active graph and Tarjan condensation

**Files:**

- Create: `src/graph/relevant-graph.ts`
- Create: `src/graph/strongly-connected.ts`
- Create: `test/graph/relevant-graph.test.ts`
- Create: `test/graph/strongly-connected.test.ts`

### Interfaces

```ts
export function findStronglyConnectedComponents(
  graph: ActiveGraph,
  metrics?: GraphMetrics,
): StronglyConnectedResult;
```

The helper is source-level only, absent from `src/graph/index.ts`.

### Steps

1. Write failing tests for relevant graph construction:
   - selected non-complete nodes become roots;
   - direct blockers are relevant;
   - traversal stops before inspecting incoming edges of a complete blocker;
   - complete blockers and explanatory edges can be relevant but are absent from active nodes/edges;
   - unrelated upstream cycles remain irrelevant.
2. Implement relevant nodes/edges and active nodes/edges exactly as specified.
3. Write failing SCC tests:
   - acyclic singleton components;
   - selected cycle;
   - boundary cycle;
   - disconnected components;
   - final component sorting;
   - `componentByNodeId` indexes remapped after sorting;
   - all ActiveGraph preconditions represented in fixtures.
4. Implement Tarjan deterministically over sorted adjacency.
5. Add the SCC golden fixture required by the spec.
6. Add frozen-input tests.
7. Run:

   ```bash
   pnpm test test/graph/relevant-graph.test.ts test/graph/strongly-connected.test.ts
   pnpm typecheck
   pnpm build
   ```

8. Commit:

   ```bash
   git add src/graph/relevant-graph.ts src/graph/strongly-connected.ts test/graph/relevant-graph.test.ts test/graph/strongly-connected.test.ts
   git commit -m "feat: construct active graph and detect cycles"
   ```

---

## Task 4: Propagate blocker facts and classify selected work

**Files:**

- Create: `src/graph/propagate.ts`
- Create: `src/graph/build-dependency-wave-graph.ts`
- Create: `test/graph/build-dependency-wave-graph.test.ts`
- Modify: `src/graph/index.ts`

### Interfaces

```ts
export function buildDependencyWaveGraphInternal(
  input: DependencyGraphInput,
  metrics?: GraphMetrics,
): DependencyGraphOutcome;

export function buildDependencyWaveGraph(
  input: DependencyGraphInput,
): DependencyGraphOutcome;
```

Only `buildDependencyWaveGraph` is re-exported publicly.

### Steps

1. Write failing tests for classification precedence:
   - status-invalid selected;
   - cycle-affected selected;
   - completed-preexisting;
   - direct/transitive invalid selected blockers;
   - direct/transitive unresolved boundary blockers;
   - mixed invalid/external precedence;
   - ready;
   - blocked-selected.
2. Write failing tests for blocker fields for every disposition.
3. Implement SCC condensation and ordinary topological propagation for `blocker -> blocked` edges. Propagate local cycle, invalid-selected, and unresolved-boundary facts downstream.
4. Implement responsible-direct-blocker tracking without a full DFS per selected node.
5. Implement classification in exact priority order.
6. Write failing tests for levels and batches:
   - consecutive levels;
   - diamonds and disconnected selected components;
   - concurrency 1 and 8;
   - consecutive batches;
   - completed blockers removed from level dependencies.
7. Implement levels, batches, complete boundary output, explanatory edges, cycles, and runnable.
8. Re-export the public function from `src/graph/index.ts`; keep the internal function source-only.
9. Run:

   ```bash
   pnpm test test/graph/build-dependency-wave-graph.test.ts
   pnpm typecheck
   pnpm build
   ```

10. Commit:

    ```bash
    git add src/graph/propagate.ts src/graph/build-dependency-wave-graph.ts src/graph/index.ts test/graph/build-dependency-wave-graph.test.ts
    git commit -m "feat: calculate dependency wave graph"
    ```

---

## Task 5: Prove determinism, linear traversal, and immutability

**Files:**

- Create: `test/graph/property.test.ts`
- Create: `test/graph/complexity.test.ts`
- Create: `test/graph/immutability.test.ts`
- Modify as needed: `src/graph/build-dependency-wave-graph.ts`

### Steps

1. Add fast-check generators for valid graphs with:
   - opaque IDs including non-ASCII and whitespace-containing valid strings;
   - selected/boundary partitions;
   - acyclic graphs and controlled cycles;
   - completion barriers;
   - all valid statuses.
2. Assert permutations of nodes, edges, and selected IDs produce deep-equal outcomes.
3. Add complexity tests using `buildDependencyWaveGraphInternal(input, metrics)`:
   - initialize metrics to zero;
   - generate large chains, diamonds, and wide DAGs;
   - assert each counter is `<= 12 * (V + E)`;
   - verify the public wrapper returns the same outcome as the internal function without metrics.
4. Add deep-freeze property/fixture tests proving no mutation.
5. Run the complete quality gate:

   ```bash
   pnpm test
   pnpm typecheck
   pnpm build
   ```

6. Inspect package contents and public exports:

   ```bash
   pnpm pack --dry-run
   ```

   Confirm only the intended `./graph` public API is exposed and test-only helpers are not package exports.
7. Commit:

   ```bash
   git add test/graph/property.test.ts test/graph/complexity.test.ts test/graph/immutability.test.ts src/graph/build-dependency-wave-graph.ts
   git commit -m "test: prove graph planner determinism and complexity"
   ```

---

## Final verification

Run from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
git status --short
```

Expected:

- all tests pass;
- typecheck and build succeed;
- package exposes only `./graph` for this module;
- working tree is clean;
- no GitHub/Git/pi orchestration code exists in this implementation.
