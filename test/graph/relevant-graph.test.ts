import { describe, expect, it } from "vitest";
import type { DependencyGraphInput } from "../../src/graph/contracts.js";
import { buildRelevantGraph } from "../../src/graph/relevant-graph.js";
import { validateGraph } from "../../src/graph/validate-graph.js";

function validated(input: DependencyGraphInput) {
  const outcome = validateGraph(input);
  if (outcome.kind !== "valid") throw new Error(JSON.stringify(outcome.errors));
  return outcome.graph;
}

describe("buildRelevantGraph", () => {
  it("stops active traversal at completed blockers", () => {
    const graph = validated({
      schemaVersion: 1,
      maxConcurrency: 3,
      selectedIds: ["selected"],
      nodes: [
        { id: "selected", issueNumber: 4, status: "eligible" },
        { id: "complete", issueNumber: 3, status: "complete" },
        { id: "cycle-a", issueNumber: 1, status: "unresolved" },
        { id: "cycle-b", issueNumber: 2, status: "unresolved" },
      ],
      edges: [
        { blockerId: "complete", blockedId: "selected" },
        { blockerId: "cycle-b", blockedId: "complete" },
        { blockerId: "cycle-a", blockedId: "cycle-b" },
        { blockerId: "cycle-b", blockedId: "cycle-a" },
      ],
    });

    const relevant = buildRelevantGraph(graph);

    expect(relevant.relevantNodeIds).toEqual(["complete", "selected"]);
    expect(relevant.relevantEdges).toEqual([
      { blockerId: "complete", blockedId: "selected" },
    ]);
    expect(relevant.active.nodeIds).toEqual(["selected"]);
    expect(relevant.active.outgoing.get("selected")).toEqual([]);
  });

  it("includes incomplete blockers and their incoming edges", () => {
    const graph = validated({
      schemaVersion: 1,
      maxConcurrency: 2,
      selectedIds: ["selected"],
      nodes: [
        { id: "selected", issueNumber: 3, status: "eligible" },
        { id: "middle", issueNumber: 2, status: "unresolved" },
        { id: "root", issueNumber: 1, status: "unresolved" },
      ],
      edges: [
        { blockerId: "middle", blockedId: "selected" },
        { blockerId: "root", blockedId: "middle" },
      ],
    });

    const relevant = buildRelevantGraph(graph);

    expect(relevant.relevantNodeIds).toEqual(["root", "middle", "selected"]);
    expect(relevant.active.nodeIds).toEqual(["root", "middle", "selected"]);
    expect(relevant.active.outgoing.get("root")).toEqual(["middle"]);
    expect(relevant.active.outgoing.get("middle")).toEqual(["selected"]);
  });
});
