import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DependencyGraphInput } from "../../src/graph/contracts.js";
import { buildDependencyWaveGraph } from "../../src/graph/index.js";

const nodes = [
  { id: " α ", issueNumber: 1, status: "eligible" as const },
  { id: "é", issueNumber: 2, status: "eligible" as const },
  { id: "東京", issueNumber: 3, status: "eligible" as const },
  { id: "🙂", issueNumber: 4, status: "eligible" as const },
];
const edges = [
  { blockerId: " α ", blockedId: "東京" },
  { blockerId: "é", blockedId: "東京" },
  { blockerId: "東京", blockedId: "🙂" },
];
const selectedIds = nodes.map((node) => node.id);

function permutations<T>(values: readonly T[]) {
  return fc.shuffledSubarray([...values], {
    minLength: values.length,
    maxLength: values.length,
  });
}

describe("dependency graph determinism", () => {
  it("is invariant to node, edge, and selection order", () => {
    const baseline = buildDependencyWaveGraph({
      schemaVersion: 1,
      maxConcurrency: 2,
      nodes: [...nodes],
      edges: [...edges],
      selectedIds: [...selectedIds],
    });

    fc.assert(
      fc.property(
        permutations(nodes),
        permutations(edges),
        permutations(selectedIds),
        (permutedNodes, permutedEdges, permutedSelected) => {
          const input: DependencyGraphInput = {
            schemaVersion: 1,
            maxConcurrency: 2,
            nodes: permutedNodes,
            edges: permutedEdges,
            selectedIds: permutedSelected,
          };
          expect(buildDependencyWaveGraph(input)).toEqual(baseline);
        },
      ),
      { numRuns: 100 },
    );
  });
});
