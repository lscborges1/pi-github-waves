import { describe, expect, it } from "vitest";
import type {
  DependencyEdge,
  DependencyGraphInput,
  DependencyNode,
} from "../../src/graph/contracts.js";
import { buildDependencyWaveGraph } from "../../src/graph/index.js";

function input(
  nodes: DependencyNode[],
  selectedIds: string[],
  edges: DependencyEdge[],
  maxConcurrency = 3,
): DependencyGraphInput {
  return { schemaVersion: 1, maxConcurrency, nodes, selectedIds, edges };
}

function planned(graphInput: DependencyGraphInput) {
  const outcome = buildDependencyWaveGraph(graphInput);
  expect(outcome.kind).toBe("planned");
  if (outcome.kind !== "planned") throw new Error(JSON.stringify(outcome.errors));
  return outcome.graph;
}

describe("buildDependencyWaveGraph", () => {
  it("calculates deterministic levels for a dependency diamond", () => {
    const graph = planned(
      input(
        [
          { id: "a", issueNumber: 1, status: "eligible" },
          { id: "b", issueNumber: 2, status: "eligible" },
          { id: "c", issueNumber: 3, status: "eligible" },
          { id: "d", issueNumber: 4, status: "eligible" },
        ],
        ["d", "b", "a", "c"],
        [
          { blockerId: "a", blockedId: "c" },
          { blockerId: "b", blockedId: "c" },
          { blockerId: "c", blockedId: "d" },
        ],
        2,
      ),
    );

    expect(graph.runnable).toBe(true);
    expect(graph.selected).toEqual([
      {
        id: "a",
        issueNumber: 1,
        disposition: "ready",
        level: 1,
        directBlockerNumbers: [],
        unresolvedBlockerNumbers: [],
      },
      {
        id: "b",
        issueNumber: 2,
        disposition: "ready",
        level: 1,
        directBlockerNumbers: [],
        unresolvedBlockerNumbers: [],
      },
      {
        id: "c",
        issueNumber: 3,
        disposition: "blocked_selected",
        level: 2,
        directBlockerNumbers: [1, 2],
        unresolvedBlockerNumbers: [1, 2],
      },
      {
        id: "d",
        issueNumber: 4,
        disposition: "blocked_selected",
        level: 3,
        directBlockerNumbers: [3],
        unresolvedBlockerNumbers: [3],
      },
    ]);
    expect(graph.levels).toEqual([
      { level: 1, batches: [[1, 2]] },
      { level: 2, batches: [[3]] },
      { level: 3, batches: [[4]] },
    ]);
  });

  it("isolates selected invalid work and propagates it to dependents", () => {
    const graph = planned(
      input(
        [
          { id: "bad", issueNumber: 1, status: "invalid" },
          { id: "child", issueNumber: 2, status: "eligible" },
        ],
        ["bad", "child"],
        [{ blockerId: "bad", blockedId: "child" }],
      ),
    );

    expect(graph.runnable).toBe(false);
    expect(graph.selected.map(({ disposition, unresolvedBlockerNumbers }) => ({
      disposition,
      unresolvedBlockerNumbers,
    }))).toEqual([
      { disposition: "invalid", unresolvedBlockerNumbers: [] },
      {
        disposition: "blocked_invalid_selected",
        unresolvedBlockerNumbers: [1],
      },
    ]);
  });

  it("propagates unresolved external blockers", () => {
    const graph = planned(
      input(
        [
          { id: "external", issueNumber: 1, status: "unresolved" },
          { id: "selected", issueNumber: 2, status: "eligible" },
        ],
        ["selected"],
        [{ blockerId: "external", blockedId: "selected" }],
      ),
    );

    expect(graph.selected[0]).toMatchObject({
      disposition: "blocked_external",
      level: null,
      directBlockerNumbers: [1],
      unresolvedBlockerNumbers: [1],
    });
    expect(graph.boundary).toEqual([
      { id: "external", issueNumber: 1, status: "unresolved", relevant: true },
    ]);
  });

  it("gives invalid selected blockers precedence over external blockers", () => {
    const graph = planned(
      input(
        [
          { id: "bad", issueNumber: 1, status: "invalid" },
          { id: "external", issueNumber: 2, status: "unresolved" },
          { id: "selected", issueNumber: 3, status: "eligible" },
        ],
        ["bad", "selected"],
        [
          { blockerId: "bad", blockedId: "selected" },
          { blockerId: "external", blockedId: "selected" },
        ],
      ),
    );

    expect(graph.selected[1]).toMatchObject({
      disposition: "blocked_invalid_selected",
      unresolvedBlockerNumbers: [1],
    });
  });

  it("marks cycle members and their selected dependents invalid", () => {
    const graph = planned(
      input(
        [
          { id: "a", issueNumber: 1, status: "eligible" },
          { id: "b", issueNumber: 2, status: "eligible" },
          { id: "child", issueNumber: 3, status: "eligible" },
        ],
        ["a", "b", "child"],
        [
          { blockerId: "a", blockedId: "b" },
          { blockerId: "b", blockedId: "a" },
          { blockerId: "b", blockedId: "child" },
        ],
      ),
    );

    expect(graph.cycles).toEqual([{ issueNumbers: [1, 2] }]);
    expect(graph.selected.map((entry) => entry.disposition)).toEqual([
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(graph.levels).toEqual([]);
  });

  it("detects boundary and selected-to-boundary cycles while preserving unaffected siblings", () => {
    const boundaryCycle = planned(
      input(
        [
          { id: "x", issueNumber: 1, status: "unresolved" },
          { id: "y", issueNumber: 2, status: "unresolved" },
          { id: "blocked", issueNumber: 3, status: "eligible" },
          { id: "sibling", issueNumber: 4, status: "eligible" },
        ],
        ["blocked", "sibling"],
        [
          { blockerId: "x", blockedId: "y" },
          { blockerId: "y", blockedId: "x" },
          { blockerId: "y", blockedId: "blocked" },
        ],
      ),
    );
    expect(boundaryCycle.cycles).toEqual([{ issueNumbers: [1, 2] }]);
    expect(boundaryCycle.selected.map((entry) => entry.disposition)).toEqual([
      "invalid",
      "ready",
    ]);

    const mixedCycle = planned(
      input(
        [
          { id: "boundary", issueNumber: 1, status: "unresolved" },
          { id: "selected", issueNumber: 2, status: "eligible" },
        ],
        ["selected"],
        [
          { blockerId: "boundary", blockedId: "selected" },
          { blockerId: "selected", blockedId: "boundary" },
        ],
      ),
    );
    expect(mixedCycle.cycles).toEqual([{ issueNumbers: [1, 2] }]);
    expect(mixedCycle.selected[0]!.disposition).toBe("invalid");
  });

  it("stops cycles and blockers behind completed work", () => {
    const graph = planned(
      input(
        [
          { id: "cycle-a", issueNumber: 1, status: "unresolved" },
          { id: "cycle-b", issueNumber: 2, status: "unresolved" },
          { id: "done", issueNumber: 3, status: "complete" },
          { id: "selected", issueNumber: 4, status: "eligible" },
        ],
        ["selected"],
        [
          { blockerId: "cycle-a", blockedId: "cycle-b" },
          { blockerId: "cycle-b", blockedId: "cycle-a" },
          { blockerId: "cycle-b", blockedId: "done" },
          { blockerId: "done", blockedId: "selected" },
        ],
      ),
    );

    expect(graph.cycles).toEqual([]);
    expect(graph.selected[0]).toMatchObject({
      disposition: "ready",
      level: 1,
      directBlockerNumbers: [3],
      unresolvedBlockerNumbers: [],
    });
    expect(graph.boundary).toEqual([
      { id: "cycle-a", issueNumber: 1, status: "unresolved", relevant: false },
      { id: "cycle-b", issueNumber: 2, status: "unresolved", relevant: false },
      { id: "done", issueNumber: 3, status: "complete", relevant: false },
    ]);
  });

  it("returns complete-only and empty selections without execution levels", () => {
    const complete = planned(
      input([{ id: "done", issueNumber: 1, status: "complete" }], ["done"], []),
    );
    expect(complete.runnable).toBe(true);
    expect(complete.selected[0]).toMatchObject({
      disposition: "completed_preexisting",
      level: null,
    });
    expect(complete.levels).toEqual([]);

    const empty = planned(input([], [], []));
    expect(empty.runnable).toBe(false);
    expect(empty.selected).toEqual([]);
    expect(empty.levels).toEqual([]);
  });
});
