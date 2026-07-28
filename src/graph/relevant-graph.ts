import type {
  ActiveGraph,
  DependencyEdge,
  GraphMetrics,
  ValidatedGraph,
} from "./contracts.js";
import { compareNumberThenId } from "./compare.js";

export interface RelevantGraph {
  relevantNodeIds: string[];
  relevantEdges: DependencyEdge[];
  active: ActiveGraph;
}

export function buildRelevantGraph(
  graph: ValidatedGraph,
  metrics?: GraphMetrics,
): RelevantGraph {
  const relevant = new Set<string>();
  const expanded = new Set<string>();
  const relevantEdgeKeys = new Set<string>();
  const queue = graph.selectedIds.filter(
    (id) => graph.nodesById.get(id)?.status !== "complete",
  );

  const compareIds = (a: string, b: string): number =>
    compareNumberThenId(graph.nodesById.get(a)!, graph.nodesById.get(b)!);
  queue.sort(compareIds);
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const id = queue[queueIndex++]!;
    if (expanded.has(id)) continue;
    expanded.add(id);
    relevant.add(id);
    if (metrics) metrics.nodeVisits += 1;

    for (const blockerId of graph.incoming.get(id) ?? []) {
      if (metrics) metrics.edgeVisits += 1;
      relevantEdgeKeys.add(`${blockerId}\0${id}`);
      relevant.add(blockerId);
      if (
        graph.nodesById.get(blockerId)?.status !== "complete" &&
        !expanded.has(blockerId)
      ) {
        queue.push(blockerId);
      }
    }
  }

  const relevantNodeIds = [...relevant].sort(compareIds);
  const relevantEdges = graph.edges
    .filter((edge) => relevantEdgeKeys.has(`${edge.blockerId}\0${edge.blockedId}`))
    .map((edge) => ({ ...edge }));
  const activeNodeIds = relevantNodeIds.filter(
    (id) => graph.nodesById.get(id)?.status !== "complete",
  );
  const activeSet = new Set(activeNodeIds);
  const outgoingMutable = new Map<string, string[]>(
    activeNodeIds.map((id) => [id, []]),
  );
  for (const edge of relevantEdges) {
    if (activeSet.has(edge.blockerId) && activeSet.has(edge.blockedId)) {
      outgoingMutable.get(edge.blockerId)!.push(edge.blockedId);
    }
  }
  const outgoing = new Map<string, readonly string[]>();
  for (const id of activeNodeIds) {
    outgoing.set(id, outgoingMutable.get(id)!.sort(compareIds));
  }

  return {
    relevantNodeIds,
    relevantEdges,
    active: {
      nodeIds: activeNodeIds,
      issueNumberById: new Map(
        activeNodeIds.map((id) => [id, graph.nodesById.get(id)!.issueNumber]),
      ),
      outgoing,
    },
  };
}
