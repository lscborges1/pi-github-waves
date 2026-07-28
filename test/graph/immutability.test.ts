import { describe, expect, it } from "vitest";
import type { DependencyGraphInput } from "../../src/graph/contracts.js";
import { buildDependencyWaveGraph } from "../../src/graph/index.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

describe("dependency graph input ownership", () => {
  it("does not mutate deeply frozen input", () => {
    const input: DependencyGraphInput = {
      schemaVersion: 1,
      maxConcurrency: 2,
      selectedIds: ["b", "a"],
      nodes: [
        { id: "b", issueNumber: 2, status: "eligible" },
        { id: "a", issueNumber: 1, status: "eligible" },
      ],
      edges: [{ blockerId: "a", blockedId: "b" }],
    };
    const before = structuredClone(input);
    deepFreeze(input);

    expect(buildDependencyWaveGraph(input).kind).toBe("planned");
    expect(input).toEqual(before);
  });
});
