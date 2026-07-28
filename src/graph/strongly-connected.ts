import type {
  ActiveGraph,
  GraphMetrics,
  StronglyConnectedResult,
} from "./contracts.js";

export function findStronglyConnectedComponents(
  graph: ActiveGraph,
  metrics?: GraphMetrics,
): StronglyConnectedResult {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const rawComponents: string[][] = [];

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
    rawComponents.push(component);
  };

  for (const id of graph.nodeIds) {
    if (!indexes.has(id)) connect(id);
  }

  const rawComponentByNodeId = new Map<string, number>();
  rawComponents.forEach((component, rawIndex) => {
    for (const id of component) rawComponentByNodeId.set(id, rawIndex);
  });

  const orderedRawIndexes: number[] = [];
  const orderedMembers = new Map<number, string[]>();
  for (const id of graph.nodeIds) {
    const rawIndex = rawComponentByNodeId.get(id)!;
    let members = orderedMembers.get(rawIndex);
    if (!members) {
      members = [];
      orderedMembers.set(rawIndex, members);
      orderedRawIndexes.push(rawIndex);
    }
    members.push(id);
  }

  const components = orderedRawIndexes.map((rawIndex) => {
    const nodeIds = orderedMembers.get(rawIndex)!;
    return { nodeIds, cyclic: nodeIds.length > 1 };
  });
  const componentByNodeId = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const id of component.nodeIds) {
      componentByNodeId.set(id, componentIndex);
    }
  });

  return { components, componentByNodeId };
}
