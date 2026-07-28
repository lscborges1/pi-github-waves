import {
  GRAPH_SCHEMA_VERSION,
  MAX_BOUNDARY_NODES,
  MAX_EDGES,
  MAX_SELECTED_NODES,
  type DependencyEdge,
  type DependencyGraphInput,
  type DependencyNode,
  type GraphError,
  type GraphValidationOutcome,
  type ValidatedGraph,
} from "./contracts.js";
import {
  compareNumberThenId,
  compareOpaqueId,
  compareUnicodeCodePoints,
} from "./compare.js";

function isPositiveSafeInteger(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0)
  );
}

function normalizeNumber(value: number): number | string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return value;
}

function stableDetails(details: GraphError["details"]): string {
  return Object.keys(details)
    .sort(compareUnicodeCodePoints)
    .map((key) => {
      const value = details[key];
      return `${key}=${typeof value === "number" ? String(value) : JSON.stringify(value)}`;
    })
    .join(";");
}

function sortErrors(errors: GraphError[]): GraphError[] {
  return [...errors].sort((a, b) => {
    if (a.issueNumber === null && b.issueNumber !== null) return -1;
    if (a.issueNumber !== null && b.issueNumber === null) return 1;
    if (a.issueNumber !== null && b.issueNumber !== null) {
      const numberOrder = a.issueNumber - b.issueNumber;
      if (numberOrder !== 0) return numberOrder;
    }
    return (
      compareUnicodeCodePoints(a.code, b.code) ||
      compareUnicodeCodePoints(stableDetails(a.details), stableDetails(b.details))
    );
  });
}

function invalid(errors: GraphError[]): GraphValidationOutcome {
  return { kind: "invalid", errors: sortErrors(errors) };
}

function grouped<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function compareIds(
  a: string,
  b: string,
  nodesById: ReadonlyMap<string, DependencyNode>,
): number {
  if (a === b) return 0;
  const nodeA = nodesById.get(a);
  const nodeB = nodesById.get(b);
  if (!nodeA || !nodeB) return compareOpaqueId(a, b);
  return compareNumberThenId(nodeA, nodeB);
}

function sortIds(ids: Iterable<string>, nodesById: ReadonlyMap<string, DependencyNode>): string[] {
  return [...ids].sort((a, b) => compareIds(a, b, nodesById));
}

export function validateGraph(
  input: DependencyGraphInput,
): GraphValidationOutcome {
  const row1: GraphError[] = [];
  const validNumberCounts = new Map<number, number>();
  for (const entry of input.nodes) {
    if (isPositiveSafeInteger(entry.issueNumber)) {
      validNumberCounts.set(
        entry.issueNumber,
        (validNumberCounts.get(entry.issueNumber) ?? 0) + 1,
      );
    }
  }

  if (input.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    row1.push({
      code: "schema_version_unsupported",
      issueNumber: null,
      details: { actual: normalizeNumber(input.schemaVersion), expected: 1 },
    });
  }
  if (
    !Number.isInteger(input.maxConcurrency) ||
    input.maxConcurrency < 1 ||
    input.maxConcurrency > 8
  ) {
    row1.push({
      code: "concurrency_out_of_range",
      issueNumber: null,
      details: {
        actual: normalizeNumber(input.maxConcurrency),
        expected: "integer 1..8",
      },
    });
  }

  input.nodes.forEach((entry, nodeIndex) => {
    if (entry.id.trim().length === 0) {
      const attributable =
        isPositiveSafeInteger(entry.issueNumber) &&
        validNumberCounts.get(entry.issueNumber) === 1
          ? entry.issueNumber
          : null;
      row1.push({
        code: "invalid_node_id",
        issueNumber: attributable,
        details: { nodeIndex, value: entry.id },
      });
    }
    if (!isPositiveSafeInteger(entry.issueNumber)) {
      row1.push({
        code: "invalid_issue_number",
        issueNumber: null,
        details: { nodeIndex, value: normalizeNumber(entry.issueNumber) },
      });
    }
  });

  input.selectedIds.forEach((id, selectedIndex) => {
    if (id.trim().length === 0) {
      row1.push({
        code: "invalid_selected_id",
        issueNumber: null,
        details: { selectedIndex, value: id },
      });
    }
  });

  const rawSelected = new Set(input.selectedIds);
  const boundaryCount = input.nodes.filter(
    (entry) => !rawSelected.has(entry.id),
  ).length;
  if (rawSelected.size > MAX_SELECTED_NODES) {
    row1.push({
      code: "selected_limit_exceeded",
      issueNumber: null,
      details: { actual: rawSelected.size, maximum: MAX_SELECTED_NODES },
    });
  }
  if (boundaryCount > MAX_BOUNDARY_NODES) {
    row1.push({
      code: "boundary_limit_exceeded",
      issueNumber: null,
      details: { actual: boundaryCount, maximum: MAX_BOUNDARY_NODES },
    });
  }
  if (input.edges.length > MAX_EDGES) {
    row1.push({
      code: "edge_limit_exceeded",
      issueNumber: null,
      details: { actual: input.edges.length, maximum: MAX_EDGES },
    });
  }
  if (row1.length > 0) return invalid(row1);

  const row2: GraphError[] = [];
  const nodesByIdGroups = grouped(input.nodes, (entry) => entry.id);
  const nodesByNumberGroups = grouped(input.nodes, (entry) =>
    String(entry.issueNumber),
  );
  for (const [id, entries] of nodesByIdGroups) {
    if (entries.length > 1) {
      row2.push({
        code: "duplicate_node_id",
        issueNumber: null,
        details: { id },
      });
    }
  }
  for (const entries of nodesByNumberGroups.values()) {
    if (entries.length > 1) {
      const issueNumber = entries[0]!.issueNumber;
      row2.push({
        code: "duplicate_issue_number",
        issueNumber,
        details: { issueNumber },
      });
    }
  }

  const selectedGroups = grouped(input.selectedIds, (id) => id);
  for (const [id, entries] of selectedGroups) {
    const matchingNodes = nodesByIdGroups.get(id) ?? [];
    const uniqueNode = matchingNodes.length === 1 ? matchingNodes[0] : undefined;
    const uniqueNumber =
      uniqueNode &&
      (nodesByNumberGroups.get(String(uniqueNode.issueNumber))?.length ?? 0) === 1
        ? uniqueNode.issueNumber
        : null;
    if (entries.length > 1) {
      row2.push({
        code: "duplicate_selected_id",
        issueNumber: uniqueNumber,
        details: { id },
      });
    }
    if (matchingNodes.length === 0) {
      row2.push({
        code: "selected_node_missing",
        issueNumber: null,
        details: { id },
      });
    }
  }

  const selectedSet = new Set(input.selectedIds);
  for (const entry of input.nodes) {
    const uniqueIdentity =
      nodesByIdGroups.get(entry.id)?.length === 1 &&
      nodesByNumberGroups.get(String(entry.issueNumber))?.length === 1;
    if (!uniqueIdentity) continue;
    if (selectedSet.has(entry.id)) {
      if (!(["complete", "eligible", "invalid"] as const).includes(entry.status as never)) {
        row2.push({
          code: "selected_status_invalid",
          issueNumber: entry.issueNumber,
          details: { role: "selected", status: entry.status },
        });
      }
    } else if (!(["complete", "unresolved"] as const).includes(entry.status as never)) {
      row2.push({
        code: "boundary_status_invalid",
        issueNumber: entry.issueNumber,
        details: { role: "boundary", status: entry.status },
      });
    }
  }
  if (row2.length > 0) return invalid(row2);

  const nodesById = new Map(input.nodes.map((entry) => [entry.id, entry]));
  const row3: GraphError[] = [];
  const edgeGroups = grouped(
    input.edges,
    (edge) => `${edge.blockerId.length}:${edge.blockerId}${edge.blockedId}`,
  );
  const normalizedEdges: DependencyEdge[] = [];
  for (const entries of edgeGroups.values()) {
    const edge = entries[0]!;
    const blocker = nodesById.get(edge.blockerId);
    const blocked = nodesById.get(edge.blockedId);
    if (!blocker || !blocked) {
      row3.push({
        code: "edge_endpoint_missing",
        issueNumber: blocked?.issueNumber ?? null,
        details: {
          blockedId: edge.blockedId,
          blockerId: edge.blockerId,
        },
      });
      continue;
    }
    if (edge.blockerId === edge.blockedId) {
      row3.push({
        code: "self_dependency",
        issueNumber: blocked.issueNumber,
        details: {
          blockedId: edge.blockedId,
          blockerId: edge.blockerId,
        },
      });
      continue;
    }
    if (entries.length > 1) {
      row3.push({
        code: "duplicate_edge",
        issueNumber: blocked.issueNumber,
        details: {
          blockedId: edge.blockedId,
          blockerId: edge.blockerId,
          occurrences: entries.length,
        },
      });
      continue;
    }
    normalizedEdges.push({ ...edge });
  }
  if (row3.length > 0) return invalid(row3);

  const incomingMutable = new Map<string, string[]>();
  const outgoingMutable = new Map<string, string[]>();
  for (const entry of input.nodes) {
    incomingMutable.set(entry.id, []);
    outgoingMutable.set(entry.id, []);
  }
  for (const edge of normalizedEdges) {
    incomingMutable.get(edge.blockedId)!.push(edge.blockerId);
    outgoingMutable.get(edge.blockerId)!.push(edge.blockedId);
  }
  for (const ids of incomingMutable.values()) {
    ids.sort((a, b) => compareIds(a, b, nodesById));
  }
  for (const ids of outgoingMutable.values()) {
    ids.sort((a, b) => compareIds(a, b, nodesById));
  }

  const reached = new Set<string>();
  const queue = sortIds(new Set(input.selectedIds), nodesById);
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const id = queue[queueIndex++]!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const blocker of incomingMutable.get(id) ?? []) {
      if (!reached.has(blocker)) queue.push(blocker);
    }
  }
  const row4: GraphError[] = [];
  for (const entry of input.nodes) {
    if (!selectedSet.has(entry.id) && !reached.has(entry.id)) {
      row4.push({
        code: "unreachable_boundary_node",
        issueNumber: entry.issueNumber,
        details: { reason: "unreachable" },
      });
    }
  }
  if (row4.length > 0) return invalid(row4);

  const sortedNodes = input.nodes.map((entry) => ({ ...entry })).sort(compareNumberThenId);
  const nodesByNumber = new Map(sortedNodes.map((entry) => [entry.issueNumber, entry]));
  const sortedEdges = normalizedEdges
    .map((edge) => ({ ...edge }))
    .sort((a, b) => {
      const blockerOrder = compareNumberThenId(nodesById.get(a.blockerId)!, nodesById.get(b.blockerId)!);
      if (blockerOrder !== 0) return blockerOrder;
      return compareNumberThenId(nodesById.get(a.blockedId)!, nodesById.get(b.blockedId)!);
    });
  const selectedIds = sortIds(new Set(input.selectedIds), nodesById);
  const incoming = new Map<string, readonly string[]>();
  const outgoing = new Map<string, readonly string[]>();
  for (const entry of sortedNodes) {
    incoming.set(entry.id, [...incomingMutable.get(entry.id)!]);
    outgoing.set(entry.id, [...outgoingMutable.get(entry.id)!]);
  }
  const graph: ValidatedGraph = {
    schemaVersion: 1,
    maxConcurrency: input.maxConcurrency,
    selectedIds,
    nodesById: new Map(sortedNodes.map((entry) => [entry.id, entry])),
    nodesByNumber,
    nodes: sortedNodes,
    edges: sortedEdges,
    incoming,
    outgoing,
  };
  return { kind: "valid", graph };
}
