import { describe, expect, it } from "vitest";
import type {
  DependencyGraphInput,
  DependencyNode,
  GraphError,
} from "../../src/graph/contracts.js";
import { validateGraph } from "../../src/graph/validate-graph.js";

function node(
  id: string,
  issueNumber: number,
  status: DependencyNode["status"],
): DependencyNode {
  return { id, issueNumber, status };
}

function validInput(): DependencyGraphInput {
  return {
    schemaVersion: 1,
    maxConcurrency: 3,
    selectedIds: ["selected"],
    nodes: [node("selected", 2, "eligible"), node("boundary", 1, "complete")],
    edges: [{ blockerId: "boundary", blockedId: "selected" }],
  };
}

function errors(input: DependencyGraphInput): GraphError[] {
  const outcome = validateGraph(input);
  expect(outcome.kind).toBe("invalid");
  if (outcome.kind !== "invalid") throw new Error("Expected invalid graph");
  return outcome.errors;
}

describe("validateGraph", () => {
  it("normalizes a valid graph without mutating opaque IDs", () => {
    const input = validInput();
    const outcome = validateGraph(input);

    expect(outcome.kind).toBe("valid");
    if (outcome.kind !== "valid") throw new Error("Expected valid graph");
    expect(outcome.graph.nodes.map((entry) => entry.id)).toEqual([
      "boundary",
      "selected",
    ]);
    expect(outcome.graph.selectedIds).toEqual(["selected"]);
    expect(outcome.graph.incoming.get("selected")).toEqual(["boundary"]);
    expect(outcome.graph.outgoing.get("boundary")).toEqual(["selected"]);
  });

  it("collects Row 1 scalar errors and skips identity errors", () => {
    const input = validInput();
    input.schemaVersion = 2;
    input.maxConcurrency = 9;
    input.nodes = [
      node(" ", 1, "eligible"),
      node("also-invalid", Number.NaN, "eligible"),
      node("dup", 2, "eligible"),
      node("dup", 2, "eligible"),
    ];
    input.selectedIds = [" "];
    input.edges = [];

    expect(errors(input)).toEqual([
      {
        code: "concurrency_out_of_range",
        issueNumber: null,
        details: { actual: 9, expected: "integer 1..8" },
      },
      {
        code: "invalid_issue_number",
        issueNumber: null,
        details: { nodeIndex: 1, value: "NaN" },
      },
      {
        code: "invalid_selected_id",
        issueNumber: null,
        details: { selectedIndex: 0, value: " " },
      },
      {
        code: "schema_version_unsupported",
        issueNumber: null,
        details: { actual: 2, expected: 1 },
      },
      {
        code: "invalid_node_id",
        issueNumber: 1,
        details: { nodeIndex: 0, value: " " },
      },
    ]);
  });

  it("reports limits once", () => {
    const input = validInput();
    input.selectedIds = Array.from({ length: 51 }, (_, index) => `s-${index}`);
    input.nodes = Array.from({ length: 201 }, (_, index) =>
      node(`b-${index}`, index + 1, "unresolved"),
    );
    input.edges = Array.from({ length: 10_001 }, () => ({
      blockerId: "b-0",
      blockedId: "b-1",
    }));

    expect(errors(input)).toEqual([
      {
        code: "boundary_limit_exceeded",
        issueNumber: null,
        details: { actual: 201, maximum: 200 },
      },
      {
        code: "edge_limit_exceeded",
        issueNumber: null,
        details: { actual: 10_001, maximum: 10_000 },
      },
      {
        code: "selected_limit_exceeded",
        issueNumber: null,
        details: { actual: 51, maximum: 50 },
      },
    ]);
  });

  it("resolves overlapping Row 2 identity errors deterministically", () => {
    const input = validInput();
    input.nodes = [
      node("dup-id", 1, "eligible"),
      node("dup-id", 2, "eligible"),
      node("other", 2, "unresolved"),
    ];
    input.selectedIds = ["dup-id", "dup-id", "missing"];
    input.edges = [];

    expect(errors(input)).toEqual([
      {
        code: "duplicate_node_id",
        issueNumber: null,
        details: { id: "dup-id" },
      },
      {
        code: "duplicate_selected_id",
        issueNumber: null,
        details: { id: "dup-id" },
      },
      {
        code: "selected_node_missing",
        issueNumber: null,
        details: { id: "missing" },
      },
      {
        code: "duplicate_issue_number",
        issueNumber: 2,
        details: { issueNumber: 2 },
      },
    ]);
  });

  it("validates selected and boundary statuses", () => {
    const input = validInput();
    input.nodes = [
      node("selected", 1, "unresolved"),
      node("boundary", 2, "eligible"),
    ];
    input.edges = [{ blockerId: "boundary", blockedId: "selected" }];

    expect(errors(input)).toEqual([
      {
        code: "selected_status_invalid",
        issueNumber: 1,
        details: { role: "selected", status: "unresolved" },
      },
      {
        code: "boundary_status_invalid",
        issueNumber: 2,
        details: { role: "boundary", status: "eligible" },
      },
    ]);
  });

  it("applies edge failure precedence", () => {
    const input = validInput();
    input.nodes = [node("selected", 1, "eligible"), node("b", 2, "complete")];
    input.selectedIds = ["selected"];
    input.edges = [
      { blockerId: "missing", blockedId: "selected" },
      { blockerId: "missing", blockedId: "selected" },
      { blockerId: "b", blockedId: "b" },
      { blockerId: "b", blockedId: "selected" },
      { blockerId: "b", blockedId: "selected" },
    ];

    expect(errors(input)).toEqual([
      {
        code: "duplicate_edge",
        issueNumber: 1,
        details: { blockedId: "selected", blockerId: "b", occurrences: 2 },
      },
      {
        code: "edge_endpoint_missing",
        issueNumber: 1,
        details: { blockedId: "selected", blockerId: "missing" },
      },
      {
        code: "self_dependency",
        issueNumber: 2,
        details: { blockedId: "b", blockerId: "b" },
      },
    ]);
  });

  it("rejects boundary nodes outside the selected blocker closure", () => {
    const input = validInput();
    input.nodes.push(node("unrelated", 3, "unresolved"));

    expect(errors(input)).toEqual([
      {
        code: "unreachable_boundary_node",
        issueNumber: 3,
        details: { reason: "unreachable" },
      },
    ]);
  });

  it("accepts an empty graph but rejects non-empty nodes without selection", () => {
    const empty = validateGraph({
      schemaVersion: 1,
      maxConcurrency: 1,
      selectedIds: [],
      nodes: [],
      edges: [],
    });
    expect(empty.kind).toBe("valid");

    expect(
      errors({
        schemaVersion: 1,
        maxConcurrency: 1,
        selectedIds: [],
        nodes: [node("boundary", 1, "unresolved")],
        edges: [],
      }),
    ).toEqual([
      {
        code: "unreachable_boundary_node",
        issueNumber: 1,
        details: { reason: "unreachable" },
      },
    ]);
  });

  it("supports deeply frozen input without mutation", () => {
    const input = validInput();
    Object.freeze(input.nodes[0]);
    Object.freeze(input.nodes[1]);
    Object.freeze(input.edges[0]);
    Object.freeze(input.nodes);
    Object.freeze(input.edges);
    Object.freeze(input.selectedIds);
    Object.freeze(input);

    expect(validateGraph(input).kind).toBe("valid");
  });
});
