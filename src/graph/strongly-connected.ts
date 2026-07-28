import type {
  ActiveGraph,
  GraphMetrics,
  StronglyConnectedResult,
} from "./contracts.js";
import { compareOpaqueId } from "./compare.js";

function compareNodeIds(graph: ActiveGraph, a: string, b: string): number {
  return (
    graph.issueNumberById.get(a)! - graph.issueNumberById.get(b)! ||
    compareOpaqueId(a, b)
  );
}

export function findStronglyConnectedComponents(
  graph: ActiveGraph,
  metrics?: GraphMetrics,
): StronglyConnectedResult {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const discovered: string[][] = [];

  const connect = (id: string): void => {
    if (metrics) metrics.nodeVisits += 1;
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const neighbor of graph.outgoing.get(id) ?? []) {
      if (metrics) metrics.edgeVisits += 1;
      if (!indexes.has(neighbor)) {
        connect(neighbor);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indexes.get(neighbor)!));
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((a, b) => compareNodeIds(graph, a, b));
    discovered.push(component);
  };

  for (const id of graph.nodeIds) {
    if (!indexes.has(id)) connect(id);
  }

  discovered.sort((a, b) => {
    const first = compareNodeIds(graph, a[0]!, b[0]!);
    if (first !== 0) return first;
    for (let index = 1; index < Math.min(a.length, b.length); index += 1) {
      const order = compareNodeIds(graph, a[index]!, b[index]!);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  });

  const components = discovered.map((nodeIds) => ({
    nodeIds,
    cyclic: nodeIds.length > 1,
  }));
  const componentByNodeId = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const id of component.nodeIds) {
      componentByNodeId.set(id, componentIndex);
    }
  });

  return { components, componentByNodeId };
}
