export const GRAPH_SCHEMA_VERSION = 1 as const;
export const MAX_SELECTED_NODES = 50;
export const MAX_BOUNDARY_NODES = 200;
export const MAX_EDGES = 10_000;

export type NodeStatus =
  | "complete"
  | "eligible"
  | "invalid"
  | "unresolved";

export interface DependencyNode {
  id: string;
  issueNumber: number;
  status: NodeStatus;
}

export interface DependencyEdge {
  blockerId: string;
  blockedId: string;
}

export interface DependencyGraphInput {
  schemaVersion: number;
  maxConcurrency: number;
  selectedIds: string[];
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export type SelectedDisposition =
  | "ready"
  | "blocked_selected"
  | "blocked_external"
  | "blocked_invalid_selected"
  | "completed_preexisting"
  | "invalid";

export interface PlannedSelectedNode {
  id: string;
  issueNumber: number;
  disposition: SelectedDisposition;
  level: number | null;
  directBlockerNumbers: number[];
  unresolvedBlockerNumbers: number[];
}

export interface PlannedBoundaryNode {
  id: string;
  issueNumber: number;
  status: "complete" | "unresolved";
  relevant: boolean;
}

export interface DependencyCycle {
  issueNumbers: number[];
}

export interface DependencyWaveGraph {
  schemaVersion: 1;
  runnable: boolean;
  selected: PlannedSelectedNode[];
  boundary: PlannedBoundaryNode[];
  edges: Array<{
    blockerId: string;
    blockerNumber: number;
    blockedId: string;
    blockedNumber: number;
  }>;
  cycles: DependencyCycle[];
  levels: Array<{ level: number; batches: number[][] }>;
}

export type GraphErrorCode =
  | "schema_version_unsupported"
  | "concurrency_out_of_range"
  | "selected_limit_exceeded"
  | "boundary_limit_exceeded"
  | "edge_limit_exceeded"
  | "invalid_node_id"
  | "invalid_selected_id"
  | "invalid_issue_number"
  | "duplicate_node_id"
  | "duplicate_issue_number"
  | "duplicate_selected_id"
  | "selected_node_missing"
  | "selected_status_invalid"
  | "boundary_status_invalid"
  | "unreachable_boundary_node"
  | "edge_endpoint_missing"
  | "self_dependency"
  | "duplicate_edge";

export interface GraphError {
  code: GraphErrorCode;
  issueNumber: number | null;
  details: Record<string, string | number>;
}

export type DependencyGraphOutcome =
  | { kind: "planned"; graph: DependencyWaveGraph }
  | { kind: "invalid_input"; errors: GraphError[] };

export interface GraphMetrics {
  nodeVisits: number;
  edgeVisits: number;
}

export interface ValidatedGraph {
  schemaVersion: 1;
  maxConcurrency: number;
  selectedIds: string[];
  nodesById: ReadonlyMap<string, DependencyNode>;
  nodesByNumber: ReadonlyMap<number, DependencyNode>;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  incoming: ReadonlyMap<string, readonly string[]>;
  outgoing: ReadonlyMap<string, readonly string[]>;
}

export type GraphValidationOutcome =
  | { kind: "valid"; graph: ValidatedGraph }
  | { kind: "invalid"; errors: GraphError[] };

export interface ActiveGraph {
  nodeIds: readonly string[];
  issueNumberById: ReadonlyMap<string, number>;
  outgoing: ReadonlyMap<string, readonly string[]>;
}

export interface StronglyConnectedResult {
  components: Array<{ nodeIds: string[]; cyclic: boolean }>;
  componentByNodeId: ReadonlyMap<string, number>;
}
