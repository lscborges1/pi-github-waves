import type {
  DependencyGraphInput,
  DependencyGraphOutcome,
  DependencyWaveGraph,
  GraphMetrics,
  PlannedSelectedNode,
  SelectedDisposition,
  ValidatedGraph,
} from "./contracts.js";
import { buildRelevantGraph } from "./relevant-graph.js";
import { findStronglyConnectedComponents } from "./strongly-connected.js";
import { propagateComponentFacts } from "./propagate.js";
import { validateGraph } from "./validate-graph.js";

interface Classification {
  disposition: SelectedDisposition;
  level: number | null;
  unresolved: number[];
}

function issueNumbersFor(
  graph: ValidatedGraph,
  ids: readonly string[],
): number[] {
  return ids.map((id) => graph.nodesById.get(id)!.issueNumber);
}

function selectedClassification(
  graph: ValidatedGraph,
  stronglyConnected: ReturnType<typeof findStronglyConnectedComponents>,
  facts: ReturnType<typeof propagateComponentFacts>["factsByComponent"],
  selected: ReadonlySet<string>,
  id: string,
  metrics?: GraphMetrics,
): Omit<Classification, "level"> {
  const node = graph.nodesById.get(id)!;
  const direct = graph.incoming.get(id) ?? [];
  if (metrics) {
    metrics.nodeVisits += 1;
    metrics.edgeVisits += direct.length;
  }
  const nonComplete = direct.filter(
    (blockerId) => graph.nodesById.get(blockerId)?.status !== "complete",
  );
  const componentIndex = stronglyConnected.componentByNodeId.get(id);
  const ownFacts =
    componentIndex === undefined
      ? { cycle: false, invalidSelected: false, unresolvedBoundary: false }
      : facts[componentIndex]!;

  if (node.status === "invalid" || ownFacts.cycle) {
    return {
      disposition: "invalid",
      unresolved: issueNumbersFor(graph, nonComplete),
    };
  }
  if (node.status === "complete") {
    return { disposition: "completed_preexisting", unresolved: [] };
  }

  const blockersWithFact = (
    fact: "invalidSelected" | "unresolvedBoundary",
  ): string[] =>
    nonComplete.filter((blockerId) => {
      const blockerComponent = stronglyConnected.componentByNodeId.get(blockerId);
      return blockerComponent !== undefined && facts[blockerComponent]![fact];
    });

  const invalidBlockers = blockersWithFact("invalidSelected");
  if (invalidBlockers.length > 0) {
    return {
      disposition: "blocked_invalid_selected",
      unresolved: issueNumbersFor(graph, invalidBlockers),
    };
  }
  const externalBlockers = blockersWithFact("unresolvedBoundary");
  if (externalBlockers.length > 0) {
    return {
      disposition: "blocked_external",
      unresolved: issueNumbersFor(graph, externalBlockers),
    };
  }

  const selectedBlockers = nonComplete.filter((blockerId) => selected.has(blockerId));
  return selectedBlockers.length === 0
    ? { disposition: "ready", unresolved: [] }
    : {
        disposition: "blocked_selected",
        unresolved: issueNumbersFor(graph, selectedBlockers),
      };
}

function buildLevels(
  graph: ValidatedGraph,
  classifications: Map<string, Classification>,
  metrics?: GraphMetrics,
): Array<{ level: number; batches: number[][] }> {
  const selected = new Set(graph.selectedIds);
  const memo = new Map<string, number>();
  const calculate = (id: string): number => {
    const existing = memo.get(id);
    if (existing !== undefined) return existing;
    if (metrics) metrics.nodeVisits += 1;
    const classification = classifications.get(id)!;
    if (
      classification.disposition !== "ready" &&
      classification.disposition !== "blocked_selected"
    ) {
      return 0;
    }
    const blockerIds = (graph.incoming.get(id) ?? []).filter(
      (blockerId) =>
        selected.has(blockerId) &&
        graph.nodesById.get(blockerId)?.status !== "complete",
    );
    if (metrics) metrics.edgeVisits += blockerIds.length;
    const level =
      blockerIds.length === 0
        ? 1
        : 1 + Math.max(...blockerIds.map((blockerId) => calculate(blockerId)));
    memo.set(id, level);
    return level;
  };

  for (const id of graph.selectedIds) {
    const classification = classifications.get(id)!;
    if (
      classification.disposition === "ready" ||
      classification.disposition === "blocked_selected"
    ) {
      classification.level = calculate(id);
    }
  }

  const byLevel = new Map<number, number[]>();
  for (const id of graph.selectedIds) {
    const classification = classifications.get(id)!;
    if (classification.level === null) continue;
    const numbers = byLevel.get(classification.level) ?? [];
    numbers.push(graph.nodesById.get(id)!.issueNumber);
    byLevel.set(classification.level, numbers);
  }

  const maxLevel = Math.max(0, ...byLevel.keys());
  const levels: Array<{ level: number; batches: number[][] }> = [];
  for (let level = 1; level <= maxLevel; level += 1) {
    const issueNumbers = byLevel.get(level);
    if (!issueNumbers) continue;
    const batches: number[][] = [];
    for (let index = 0; index < issueNumbers.length; index += graph.maxConcurrency) {
      batches.push(issueNumbers.slice(index, index + graph.maxConcurrency));
    }
    levels.push({ level, batches });
  }
  return levels;
}

export function buildDependencyWaveGraphInternal(
  input: DependencyGraphInput,
  metrics?: GraphMetrics,
): DependencyGraphOutcome {
  const validation = validateGraph(input);
  if (validation.kind === "invalid") {
    return { kind: "invalid_input", errors: validation.errors };
  }
  const graph = validation.graph;
  const relevant = buildRelevantGraph(graph, metrics);
  const stronglyConnected = findStronglyConnectedComponents(relevant.active, metrics);
  const propagated = propagateComponentFacts(
    graph,
    relevant,
    stronglyConnected,
    metrics,
  );

  const selectedSet = new Set(graph.selectedIds);
  const classifications = new Map<string, Classification>();
  for (const id of graph.selectedIds) {
    const base = selectedClassification(
      graph,
      stronglyConnected,
      propagated.factsByComponent,
      selectedSet,
      id,
      metrics,
    );
    classifications.set(id, { ...base, level: null });
  }
  const levels = buildLevels(graph, classifications, metrics);
  const activeSet = new Set(relevant.active.nodeIds);

  const selected: PlannedSelectedNode[] = graph.selectedIds.map((id) => {
    const node = graph.nodesById.get(id)!;
    const classification = classifications.get(id)!;
    return {
      id,
      issueNumber: node.issueNumber,
      disposition: classification.disposition,
      level: classification.level,
      directBlockerNumbers: issueNumbersFor(graph, graph.incoming.get(id) ?? []),
      unresolvedBlockerNumbers: [...classification.unresolved],
    };
  });

  const boundary = graph.nodes
    .filter((node) => !selectedSet.has(node.id))
    .map((node) => ({
      id: node.id,
      issueNumber: node.issueNumber,
      status: node.status as "complete" | "unresolved",
      relevant: activeSet.has(node.id),
    }));
  const edges = graph.edges.map((edge) => ({
    blockerId: edge.blockerId,
    blockerNumber: graph.nodesById.get(edge.blockerId)!.issueNumber,
    blockedId: edge.blockedId,
    blockedNumber: graph.nodesById.get(edge.blockedId)!.issueNumber,
  }));
  const cycles = stronglyConnected.components
    .filter((component) => component.cyclic)
    .map((component) => ({
      issueNumbers: issueNumbersFor(graph, component.nodeIds),
    }));

  const runnable =
    graph.selectedIds.length > 0 &&
    cycles.length === 0 &&
    selected.every(
      (entry) =>
        entry.disposition !== "invalid" &&
        entry.disposition !== "blocked_invalid_selected" &&
        entry.disposition !== "blocked_external",
    );
  const result: DependencyWaveGraph = {
    schemaVersion: 1,
    runnable,
    selected,
    boundary,
    edges,
    cycles,
    levels,
  };
  return { kind: "planned", graph: result };
}

export function buildDependencyWaveGraph(
  input: DependencyGraphInput,
): DependencyGraphOutcome {
  return buildDependencyWaveGraphInternal(input);
}
