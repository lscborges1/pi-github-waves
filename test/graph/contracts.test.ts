import { describe, expect, expectTypeOf, it } from "vitest";
import * as graphModule from "../../src/graph/index.js";
import type {
  DependencyGraphInput,
  DependencyGraphOutcome,
} from "../../src/graph/index.js";

describe("graph public contract", () => {
  it("exports only the graph builder and protocol constants at runtime", () => {
    expect(Object.keys(graphModule).sort()).toEqual([
      "GRAPH_SCHEMA_VERSION",
      "MAX_BOUNDARY_NODES",
      "MAX_EDGES",
      "MAX_SELECTED_NODES",
      "buildDependencyWaveGraph",
    ]);
  });

  it("exposes a typed graph-planning seam", () => {
    expectTypeOf(graphModule.buildDependencyWaveGraph).toEqualTypeOf<
      (input: DependencyGraphInput) => DependencyGraphOutcome
    >();
  });
});
