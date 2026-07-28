import { describe, expect, it } from "vitest";
import type {
  DependencyEdge,
  DependencyGraphInput,
  DependencyNode,
  GraphMetrics,
} from "../../src/graph/contracts.js";
import { buildDependencyWaveGraphInternal } from "../../src/graph/build-dependency-wave-graph.js";
import { buildDependencyWaveGraph } from "../../src/graph/index.js";

function graph(
  nodes: DependencyNode[],
  edges: DependencyEdge[],
): DependencyGraphInput {
  return {
    schemaVersion: 1,
    maxConcurrency: 8,
    selectedIds: nodes.map((node) => node.id),
    nodes,
    edges,
  };
}

function assertLinear(input: DependencyGraphInput): void {
  const metrics: GraphMetrics = { nodeVisits: 0, edgeVisits: 0 };
  const internal = buildDependencyWaveGraphInternal(input, metrics);
  const publicOutcome = buildDependencyWaveGraph(input);
  const bound = 12 * (input.nodes.length + input.edges.length);

  expect(internal).toEqual(publicOutcome);
  expect(metrics.nodeVisits).toBeLessThanOrEqual(bound);
  expect(metrics.edgeVisits).toBeLessThanOrEqual(bound);
}

describe("dependency graph traversal complexity", () => {
  it("stays within a fixed linear-pass bound for a long chain", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `n-${index}`,
      issueNumber: index + 1,
      status: "eligible" as const,
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      blockerId: nodes[index]!.id,
      blockedId: node.id,
    }));
    assertLinear(graph(nodes, edges));
  });

  it("counts a converging blocker once during relevant discovery", () => {
    const input = graph(
      [
        { id: "root", issueNumber: 1, status: "eligible" },
        { id: "left", issueNumber: 2, status: "eligible" },
        { id: "right", issueNumber: 3, status: "eligible" },
        { id: "sink", issueNumber: 4, status: "eligible" },
      ],
      [
        { blockerId: "root", blockedId: "left" },
        { blockerId: "root", blockedId: "right" },
        { blockerId: "left", blockedId: "sink" },
        { blockerId: "right", blockedId: "sink" },
      ],
    );
    assertLinear(input);
  });

  it("stays within a fixed linear-pass bound for a wide DAG", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `n-${index}`,
      issueNumber: index + 1,
      status: "eligible" as const,
    }));
    const edges = nodes.slice(0, -1).map((node) => ({
      blockerId: node.id,
      blockedId: nodes.at(-1)!.id,
    }));
    assertLinear(graph(nodes, edges));
  });
});
