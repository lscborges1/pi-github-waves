export {
  GRAPH_SCHEMA_VERSION,
  MAX_BOUNDARY_NODES,
  MAX_EDGES,
  MAX_SELECTED_NODES,
} from "./contracts.js";
export type {
  DependencyCycle,
  DependencyEdge,
  DependencyGraphInput,
  DependencyGraphOutcome,
  DependencyNode,
  DependencyWaveGraph,
  GraphError,
  GraphErrorCode,
  NodeStatus,
  PlannedBoundaryNode,
  PlannedSelectedNode,
  SelectedDisposition,
} from "./contracts.js";

export { buildDependencyWaveGraph } from "./build-dependency-wave-graph.js";
