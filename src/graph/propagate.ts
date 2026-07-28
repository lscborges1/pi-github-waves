import type {
  GraphMetrics,
  StronglyConnectedResult,
  ValidatedGraph,
} from "./contracts.js";
import type { RelevantGraph } from "./relevant-graph.js";

export interface ComponentFacts {
  cycle: boolean;
  invalidSelected: boolean;
  unresolvedBoundary: boolean;
}

export interface PropagationResult {
  factsByComponent: ComponentFacts[];
}

export function propagateComponentFacts(
  graph: ValidatedGraph,
  relevant: RelevantGraph,
  stronglyConnected: StronglyConnectedResult,
  metrics?: GraphMetrics,
): PropagationResult {
  const selected = new Set(graph.selectedIds);
  const componentCount = stronglyConnected.components.length;
  const factsByComponent = stronglyConnected.components.map((component) => {
    if (metrics) metrics.nodeVisits += component.nodeIds.length;
    return {
      cycle: component.cyclic,
      invalidSelected: component.nodeIds.some(
        (id) => selected.has(id) && graph.nodesById.get(id)?.status === "invalid",
      ),
      unresolvedBoundary: component.nodeIds.some(
        (id) => !selected.has(id) && graph.nodesById.get(id)?.status === "unresolved",
      ),
    };
  });
  const outgoing = Array.from({ length: componentCount }, () => new Set<number>());
  const indegree = Array.from({ length: componentCount }, () => 0);

  for (const [blockerId, blockedIds] of relevant.active.outgoing) {
    const blockerComponent = stronglyConnected.componentByNodeId.get(blockerId)!;
    for (const blockedId of blockedIds) {
      if (metrics) metrics.edgeVisits += 1;
      const blockedComponent = stronglyConnected.componentByNodeId.get(blockedId)!;
      if (
        blockerComponent !== blockedComponent &&
        !outgoing[blockerComponent]!.has(blockedComponent)
      ) {
        outgoing[blockerComponent]!.add(blockedComponent);
        indegree[blockedComponent] = indegree[blockedComponent]! + 1;
      }
    }
  }

  const queue = indegree
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value === 0)
    .map(({ index }) => index)
    .sort((a, b) => a - b);

  while (queue.length > 0) {
    const componentIndex = queue.shift()!;
    const component = stronglyConnected.components[componentIndex]!;
    if (metrics) metrics.nodeVisits += component.nodeIds.length;
    for (const downstream of [...outgoing[componentIndex]!].sort((a, b) => a - b)) {
      if (metrics) metrics.edgeVisits += 1;
      const source = factsByComponent[componentIndex]!;
      const target = factsByComponent[downstream]!;
      target.cycle ||= source.cycle;
      target.invalidSelected ||= source.invalidSelected;
      target.unresolvedBoundary ||= source.unresolvedBoundary;
      indegree[downstream] = indegree[downstream]! - 1;
      if (indegree[downstream] === 0) {
        queue.push(downstream);
        queue.sort((a, b) => a - b);
      }
    }
  }

  return { factsByComponent };
}
