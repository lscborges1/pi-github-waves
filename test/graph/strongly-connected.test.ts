import { describe, expect, it } from "vitest";
import type { ActiveGraph, GraphMetrics } from "../../src/graph/contracts.js";
import { findStronglyConnectedComponents } from "../../src/graph/strongly-connected.js";

function active(
  numbers: Record<string, number>,
  outgoing: Record<string, string[]>,
): ActiveGraph {
  const nodeIds = Object.keys(numbers).sort(
    (a, b) => numbers[a]! - numbers[b]! || (a < b ? -1 : a > b ? 1 : 0),
  );
  return {
    nodeIds,
    issueNumberById: new Map(nodeIds.map((id) => [id, numbers[id]!])),
    outgoing: new Map(nodeIds.map((id) => [id, outgoing[id] ?? []])),
  };
}

describe("findStronglyConnectedComponents", () => {
  it("sorts final components and remaps component indexes", () => {
    const graph = active(
      { a: 1, b: 2, c: 3, d: 4 },
      { a: ["b"], b: ["a", "c"], c: [], d: [] },
    );

    const result = findStronglyConnectedComponents(graph);

    expect(result.components).toEqual([
      { nodeIds: ["a", "b"], cyclic: true },
      { nodeIds: ["c"], cyclic: false },
      { nodeIds: ["d"], cyclic: false },
    ]);
    expect([...result.componentByNodeId.entries()].sort()).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 2],
    ]);
  });

  it("updates optional traversal metrics", () => {
    const graph = active({ a: 1, b: 2 }, { a: ["b"], b: [] });
    const metrics: GraphMetrics = { nodeVisits: 0, edgeVisits: 0 };

    findStronglyConnectedComponents(graph, metrics);

    expect(metrics).toEqual({ nodeVisits: 2, edgeVisits: 1 });
  });
});
