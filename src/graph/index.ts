export {
  GRAPH_SCHEMA_VERSION,
  MAX_BOUNDARY_NODES,
  MAX_EDGES,
  MAX_SELECTED_NODES,
} from "./contracts.js";
export type {
  ActiveGraph,
  DependencyCycle,
  DependencyEdge,
  DependencyGraphInput,
  DependencyGraphOutcome,
  DependencyNode,
  DependencyWaveGraph,
  GraphError,
  GraphErrorCode,
  GraphMetrics,
  GraphValidationOutcome,
  NodeStatus,
  PlannedBoundaryNode,
  PlannedSelectedNode,
  SelectedDisposition,
  StronglyConnectedResult,
  ValidatedGraph,
} from "./contracts.js";

import type {
  DependencyGraphInput,
  DependencyGraphOutcome,
} from "./contracts.js";

export function buildDependencyWaveGraph(
  _input: DependencyGraphInput,
): DependencyGraphOutcome {
  throw new Error("Not implemented");
}
