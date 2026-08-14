import {
  MAX_BOUNDARY_NODES,
  MAX_EDGES,
  buildDependencyWaveGraph,
  type DependencyEdge,
  type DependencyNode,
  type GraphError,
} from "../graph/index.js";
import { compareOpaqueId } from "../graph/compare.js";
import type {
  ClosureEventPage,
  ClosureEventSnapshot,
  CommandOutcome,
  CompletionEvidence,
  DependencySnapshot,
  IssueSnapshot,
  PlanDiagnostic,
  PlannedBoundaryIssueV1,
  PlannedIssueV1,
  PlanningPorts,
  PlanResultV1,
  PlanWavesInput,
  PullRequestCloserSnapshot,
  RemoteRepositorySnapshot,
} from "./contracts.js";
import { AdapterError } from "./adapter-error.js";
import { sortPlanDiagnostics } from "./diagnostics.js";
import { parseTicket } from "./parse-ticket.js";
import { asciiLowercase } from "./text.js";

const MAX_CLOSURE_EVENTS = 1_000;
const MAX_CONCURRENCY = 3 as const;

export class PlanningInvariantError extends Error {
  readonly graphErrors: readonly Readonly<
    Pick<GraphError, "code" | "issueNumber">
  >[];

  constructor(errors: readonly GraphError[]) {
    super("planning graph input was invalid");
    this.name = "PlanningInvariantError";
    this.graphErrors = errors.map(({ code, issueNumber }) => ({
      code,
      issueNumber,
    }));
  }
}

interface LoadedIssue {
  readonly snapshot: IssueSnapshot;
  readonly completion: CompletionEvidence;
}

class ClosureReadError extends AdapterError {
  declare readonly code: "not_found" | "forbidden" | "gone";

  constructor(
    error: AdapterError & {
      readonly code: "not_found" | "forbidden" | "gone";
    },
  ) {
    super(error.code, error.message, error.retryAfterSeconds, { cause: error });
    this.name = "ClosureReadError";
  }
}

export async function planWaves(
  input: PlanWavesInput,
  ports: PlanningPorts,
): Promise<CommandOutcome> {
  try {
    const discovered = await ports.repository.discover(input.cwd);
    await ports.github.authenticate();
    const repository = await ports.github.getRepository(
      discovered.owner,
      discovered.name,
    );
    if (
      !sameAscii(repository.owner, discovered.owner) ||
      !sameAscii(repository.name, discovered.name)
    ) {
      return fatal("invalid_response", "repository identity changed");
    }

    return await buildPlan(input, ports, repository);
  } catch (error: unknown) {
    if (!(error instanceof AdapterError)) throw error;
    return adapterFailure(error);
  }
}

async function buildPlan(
  input: PlanWavesInput,
  ports: PlanningPorts,
  repository: RemoteRepositorySnapshot,
): Promise<CommandOutcome> {
  const selectedSet = new Set(input.selection.selectedNumbers);
  const queue = [...input.selection.selectedNumbers]
    .sort((a, b) => a - b)
    .map((number) => ({ number, depth: 0 }));
  const queued = new Set(queue.map((entry) => entry.number));
  const boundaryNumbers = new Set<number>();
  const loaded = new Map<number, LoadedIssue>();
  const snapshots = new Map<number, IssueSnapshot>();
  const unavailable = new Set<number>();
  const dependencyIdentity = new Map<number, string>();
  const edges = new Map<string, { blockerNumber: number; blockedNumber: number }>();
  const diagnostics: PlanDiagnostic[] = [...input.selection.diagnostics];
  let completeInput = true;

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const queuedIssue = queue[queueIndex];
    if (queuedIssue === undefined) continue;
    const issueNumber = queuedIssue.number;
    const issueRole = selectedSet.has(issueNumber) ? "selected" : "boundary";

    let snapshot: IssueSnapshot;
    try {
      snapshot = await ports.github.getIssue(
        repository.owner,
        repository.name,
        issueNumber,
      );
    } catch (error: unknown) {
      if (!isReportableAdapterError(error)) throw error;
      unavailable.add(issueNumber);
      diagnostics.push(
        unavailableDiagnostic(
          issueNumber,
          "issue",
          issueRole,
          error,
        ),
      );
      completeInput = false;
      continue;
    }
    snapshots.set(issueNumber, snapshot);

    let completion: CompletionEvidence;
    try {
      completion = await loadCompletion(snapshot, repository, ports);
    } catch (error: unknown) {
      if (!(error instanceof ClosureReadError)) throw error;
      unavailable.add(issueNumber);
      diagnostics.push(
        unavailableDiagnostic(
          issueNumber,
          "closure",
          issueRole,
          error,
        ),
      );
      completeInput = false;
      continue;
    }
    loaded.set(issueNumber, { snapshot, completion });
    dependencyIdentity.set(issueNumber, snapshot.nodeId);

    if (completion.completed) {
      continue;
    }

    let dependencies: readonly DependencySnapshot[];
    try {
      dependencies = await loadDependencies(
        issueNumber,
        repository,
        ports,
        selectedSet,
        boundaryNumbers,
      );
    } catch (error: unknown) {
      if (!isReportableAdapterError(error)) throw error;
      diagnostics.push(
        unavailableDiagnostic(
          issueNumber,
          "dependencies",
          issueRole,
          error,
        ),
      );
      completeInput = false;
      continue;
    }
    const foreign = dependencies.find(
      (dependency) =>
        !sameAscii(dependency.repositoryOwner, repository.owner) ||
        !sameAscii(dependency.repositoryName, repository.name),
    );
    if (foreign !== undefined) {
      diagnostics.push({
        severity: "error",
        code: "dependency_cross_repository",
        issueNumber,
        section: null,
        line: null,
        details: {
          owner: foreign.repositoryOwner,
          repository: foreign.repositoryName,
        },
      });
      completeInput = false;
      break;
    }

    const unseenBoundary = dependencies
      .filter(
        (dependency) =>
          !selectedSet.has(dependency.number) &&
          !boundaryNumbers.has(dependency.number),
      )
      .sort(compareDependency);
    if (
      boundaryNumbers.size + unseenBoundary.length >
      MAX_BOUNDARY_NODES
    ) {
      diagnostics.push({
        severity: "error",
        code: "boundary_limit_exceeded",
        issueNumber,
        section: null,
        line: null,
        details: {
          parentIssueNumber: issueNumber,
          attemptedTotal: boundaryNumbers.size + unseenBoundary.length,
          maximum: MAX_BOUNDARY_NODES,
        },
      });
      completeInput = false;
      break;
    }

    const candidateEdges = dependencies.filter(
      (dependency) => !edges.has(edgeKey(dependency.number, issueNumber)),
    );
    if (edges.size + candidateEdges.length > MAX_EDGES) {
      diagnostics.push({
        severity: "error",
        code: "edge_limit_exceeded",
        issueNumber,
        section: null,
        line: null,
        details: {
          parentIssueNumber: issueNumber,
          attemptedTotal: edges.size + candidateEdges.length,
          maximum: MAX_EDGES,
        },
      });
      completeInput = false;
      break;
    }

    for (const dependency of dependencies) {
      const knownIdentity = dependencyIdentity.get(dependency.number);
      if (
        knownIdentity !== undefined &&
        knownIdentity !== dependency.issueNodeId
      ) {
        return fatal("invalid_response", "issue identity changed");
      }
      dependencyIdentity.set(dependency.number, dependency.issueNodeId);
      edges.set(edgeKey(dependency.number, issueNumber), {
        blockerNumber: dependency.number,
        blockedNumber: issueNumber,
      });
    }

    for (const dependency of unseenBoundary) {
      boundaryNumbers.add(dependency.number);
      if (!queued.has(dependency.number)) {
        queued.add(dependency.number);
        queue.push({ number: dependency.number, depth: queuedIssue.depth + 1 });
      }
    }
    queue.sort((a, b) => a.depth - b.depth || a.number - b.number);
  }

  return assemblePlan({
    input,
    repository,
    loaded,
    snapshots,
    unavailable,
    boundaryNumbers,
    edges: [...edges.values()],
    diagnostics,
    completeInput,
  });
}

async function loadDependencies(
  issueNumber: number,
  repository: RemoteRepositorySnapshot,
  ports: PlanningPorts,
  selectedNumbers: ReadonlySet<number>,
  boundaryNumbers: ReadonlySet<number>,
): Promise<readonly DependencySnapshot[]> {
  const byIdentity = new Map<string, DependencySnapshot>();
  for (let page = 1; ; page += 1) {
    const result = await ports.github.getBlockedBy(
      repository.owner,
      repository.name,
      issueNumber,
      page,
    );
    for (const dependency of result.dependencies) {
      byIdentity.set(
        `${asciiLowercase(dependency.repositoryOwner)}/${asciiLowercase(
          dependency.repositoryName,
        )}#${dependency.number}`,
        dependency,
      );
    }
    if (!result.hasNextPage) break;
    const unseenBoundaryCount = [...byIdentity.values()].filter(
      (dependency) =>
        !selectedNumbers.has(dependency.number) &&
        !boundaryNumbers.has(dependency.number),
    ).length;
    if (boundaryNumbers.size + unseenBoundaryCount > MAX_BOUNDARY_NODES) break;
  }
  return [...byIdentity.values()].sort(compareDependency);
}

async function loadCompletion(
  issue: IssueSnapshot,
  repository: RemoteRepositorySnapshot,
  ports: PlanningPorts,
): Promise<CompletionEvidence> {
  if (issue.state !== "CLOSED") {
    return { completed: false, pullRequests: [] };
  }

  const events: ClosureEventSnapshot[] = [];
  let cursor: string | null = null;
  for (;;) {
    let page: ClosureEventPage;
    try {
      page = await ports.github.getClosureEvents(
        repository.owner,
        repository.name,
        issue.number,
        cursor,
      );
    } catch (error: unknown) {
      if (!isReportableAdapterError(error)) throw error;
      throw new ClosureReadError(error);
    }
    if (events.length + page.events.length > MAX_CLOSURE_EVENTS) {
      throw new AdapterError(
        "resource_limit",
        "closure event limit exceeded",
      );
    }
    events.push(...page.events);
    if (!page.hasNextPage) break;
    if (events.length >= MAX_CLOSURE_EVENTS) {
      throw new AdapterError(
        "resource_limit",
        "closure event limit exceeded",
      );
    }
    if (page.endCursor === null) {
      throw new AdapterError(
        "invalid_response",
        "closure pagination cursor is missing",
      );
    }
    cursor = page.endCursor;
  }

  let epochStart = 0;
  for (const [index, event] of events.entries()) {
    if (event.kind === "reopened") epochStart = index + 1;
  }

  const closers = events
    .slice(epochStart)
    .flatMap((event) =>
      event.kind === "closed" && event.closer !== null ? [event.closer] : [],
    )
    .sort(compareCloser);
  const pullRequests: CompletionEvidence["pullRequests"][number][] = [];
  for (const closer of closers) {
    if (
      closer.mergedAt === null ||
      closer.mergeCommitOid === null ||
      closer.repositoryNodeId !== repository.nodeId ||
      !sameAscii(closer.repositoryOwner, repository.owner) ||
      !sameAscii(closer.repositoryName, repository.name)
    ) {
      continue;
    }

    let reachable = false;
    if (closer.baseBranch === repository.defaultBranch) {
      const comparison = await ports.github.compareCommits(
        repository.owner,
        repository.name,
        closer.mergeCommitOid,
        repository.defaultBranchTipOid,
      );
      reachable =
        comparison.status === "ahead" || comparison.status === "identical";
    }
    pullRequests.push({
      number: closer.number,
      url: closer.url,
      mergedAt: closer.mergedAt,
      mergeCommitOid: closer.mergeCommitOid,
      baseBranch: closer.baseBranch,
      reachable,
    });
  }

  return {
    completed: pullRequests.some((pullRequest) => pullRequest.reachable),
    pullRequests,
  };
}

function assemblePlan(options: {
  readonly input: PlanWavesInput;
  readonly repository: RemoteRepositorySnapshot;
  readonly loaded: ReadonlyMap<number, LoadedIssue>;
  readonly snapshots: ReadonlyMap<number, IssueSnapshot>;
  readonly unavailable: ReadonlySet<number>;
  readonly boundaryNumbers: ReadonlySet<number>;
  readonly edges: readonly {
    readonly blockerNumber: number;
    readonly blockedNumber: number;
  }[];
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly completeInput: boolean;
}): CommandOutcome {
  const diagnostics = [...options.diagnostics];
  const selectedNumbers = [...options.input.selection.selectedNumbers].sort(
    (a, b) => a - b,
  );
  const boundaryNumbers = [...options.boundaryNumbers].sort((a, b) => a - b);
  const nodes: DependencyNode[] = [];

  for (const issueNumber of selectedNumbers) {
    const loadedIssue = options.loaded.get(issueNumber);
    if (loadedIssue === undefined) continue;
    const status = selectedStatus(loadedIssue, diagnostics);
    nodes.push({
      id: loadedIssue.snapshot.nodeId,
      issueNumber,
      status,
    });
  }
  for (const issueNumber of boundaryNumbers) {
    const loadedIssue = options.loaded.get(issueNumber);
    if (loadedIssue === undefined) continue;
    nodes.push({
      id: loadedIssue.snapshot.nodeId,
      issueNumber,
      status: loadedIssue.completion.completed ? "complete" : "unresolved",
    });
  }

  const sortedEdges = [...options.edges].sort(
    (a, b) =>
      a.blockerNumber - b.blockerNumber || a.blockedNumber - b.blockedNumber,
  );
  let graph: PlanResultV1["graph"] = null;
  if (
    options.completeInput &&
    nodes.length === selectedNumbers.length + boundaryNumbers.length
  ) {
    const idByNumber = new Map(nodes.map((node) => [node.issueNumber, node.id]));
    const graphEdges: DependencyEdge[] = sortedEdges.flatMap((edge) => {
      const blockerId = idByNumber.get(edge.blockerNumber);
      const blockedId = idByNumber.get(edge.blockedNumber);
      return blockerId === undefined || blockedId === undefined
        ? []
        : [{ blockerId, blockedId }];
    });
    const outcome = buildDependencyWaveGraph({
      schemaVersion: 1,
      maxConcurrency: MAX_CONCURRENCY,
      selectedIds: selectedNumbers.flatMap((number) => {
        const id = idByNumber.get(number);
        return id === undefined ? [] : [id];
      }),
      nodes,
      edges: graphEdges,
    });
    if (outcome.kind === "invalid_input") {
      throw new PlanningInvariantError(outcome.errors);
    }
    graph = outcome.graph;
    for (const cycle of graph.cycles) {
      diagnostics.push({
        severity: "error",
        code: "dependency_cycle",
        issueNumber: null,
        section: null,
        line: null,
        details: { issueNumbers: cycle.issueNumbers.join(",") },
      });
    }
    for (const selected of graph.selected) {
      if (selected.disposition === "blocked_external") {
        diagnostics.push({
          severity: "error",
          code: "external_blocker_open",
          issueNumber: selected.issueNumber,
          section: null,
          line: null,
          details: {
            blockerNumbers: selected.unresolvedBlockerNumbers.join(","),
          },
        });
      }
    }
  }

  const sortedDiagnostics = sortPlanDiagnostics(diagnostics);
  const graphSelected = new Map(
    graph?.selected.map((selected) => [selected.issueNumber, selected]),
  );
  const graphBoundary = new Map(
    graph?.boundary.map((boundary) => [boundary.issueNumber, boundary]),
  );
  const selected: PlannedIssueV1[] = selectedNumbers.flatMap((number) => {
    const issue = options.loaded.get(number);
    if (issue === undefined) {
      return options.unavailable.has(number)
        ? [unavailableSelectedIssue(number, options.snapshots.get(number))]
        : [];
    }
    return [
      {
        number,
        nodeId: issue.snapshot.nodeId,
        title: issue.snapshot.title,
        url: issue.snapshot.url,
        state: issue.snapshot.state,
        labels: normalizeLabels(issue.snapshot.labels),
        updatedAt: issue.snapshot.updatedAt,
        completion: issue.completion,
        graphNode: graphSelected.get(number) ?? null,
      },
    ];
  });
  const boundary: PlannedBoundaryIssueV1[] = boundaryNumbers.flatMap((number) => {
    const issue = options.loaded.get(number);
    if (issue === undefined) {
      return options.unavailable.has(number)
        ? [unavailableBoundaryIssue(number, options.snapshots.get(number))]
        : [];
    }
    return [
      {
        number,
        nodeId: issue.snapshot.nodeId,
        title: issue.snapshot.title,
        url: issue.snapshot.url,
        state: issue.snapshot.state,
        updatedAt: issue.snapshot.updatedAt,
        completion: issue.completion,
        graphNode: graphBoundary.get(number) ?? null,
      },
    ];
  });
  const runnable =
    graph?.runnable === true &&
    !sortedDiagnostics.some((diagnostic) => diagnostic.severity === "error");

  return {
    kind: "planned",
    plan: {
      plannerSchemaVersion: 1,
      repository: options.repository,
      inputOrder: options.input.selection.inputOrder,
      maxConcurrency: MAX_CONCURRENCY,
      selected,
      boundary,
      edges: sortedEdges,
      graph,
      diagnostics: sortedDiagnostics,
      runnable,
    },
  };
}

function selectedStatus(
  issue: LoadedIssue,
  diagnostics: PlanDiagnostic[],
): DependencyNode["status"] {
  if (issue.completion.completed) return "complete";
  let valid = true;
  if (issue.snapshot.state === "CLOSED") {
    diagnostics.push({
      severity: "error",
      code: "issue_closed_uncompleted",
      issueNumber: issue.snapshot.number,
      section: null,
      line: null,
      details: { state: "CLOSED" },
    });
    valid = false;
  }

  const labels = normalizeLabels(issue.snapshot.labels);
  if (!labels.includes("agent: suitable")) {
    diagnostics.push({
      severity: "error",
      code: "label_missing",
      issueNumber: issue.snapshot.number,
      section: null,
      line: null,
      details: {},
    });
    valid = false;
  }
  const conflicting = labels.filter(
    (label) =>
      label === "agent: not suitable" || label === "agent: review required",
  );
  if (conflicting.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "label_conflict",
      issueNumber: issue.snapshot.number,
      section: null,
      line: null,
      details: { labels: conflicting.join(",") },
    });
    valid = false;
  }

  const ticket = parseTicket(issue.snapshot.number, issue.snapshot.body);
  if (ticket.kind === "invalid") {
    diagnostics.push(...ticket.diagnostics);
    valid = false;
  }
  return valid ? "eligible" : "invalid";
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  return [...new Set(labels.map((label) => asciiLowercase(trimAscii(label))))].sort(
    compareOpaqueId,
  );
}

function trimAscii(value: string): string {
  return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
}

function compareDependency(a: DependencySnapshot, b: DependencySnapshot): number {
  return a.number - b.number || compareOpaqueId(a.issueNodeId, b.issueNodeId);
}

function compareCloser(
  a: PullRequestCloserSnapshot,
  b: PullRequestCloserSnapshot,
): number {
  return a.number - b.number || compareOpaqueId(a.nodeId, b.nodeId);
}

function edgeKey(blockerNumber: number, blockedNumber: number): string {
  return `${blockerNumber}->${blockedNumber}`;
}

function sameAscii(a: string, b: string): boolean {
  return asciiLowercase(a) === asciiLowercase(b);
}

function fatal(
  code: Extract<CommandOutcome, { kind: "fatal" }>["code"],
  message: string,
): CommandOutcome {
  return { kind: "fatal", code, message, retryAfterSeconds: null };
}

function adapterFailure(error: AdapterError): CommandOutcome {
  switch (error.code) {
    case "cancelled":
      return { kind: "cancelled", message: error.message };
    case "not_found":
    case "gone":
      return fatal("invalid_response", "unexpected reportable adapter failure");
    default:
      return {
        kind: "fatal",
        code: error.code,
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      };
  }
}

function isReportableAdapterError(
  error: unknown,
): error is AdapterError & { readonly code: "not_found" | "forbidden" | "gone" } {
  return (
    error instanceof AdapterError &&
    (error.code === "not_found" ||
      error.code === "forbidden" ||
      error.code === "gone")
  );
}

function unavailableDiagnostic(
  issueNumber: number,
  resource: "issue" | "dependencies" | "closure",
  role: "selected" | "boundary",
  error: AdapterError & {
    readonly code: "not_found" | "forbidden" | "gone";
  },
): PlanDiagnostic {
  return {
    severity: "error",
    code:
      role === "selected" &&
      resource === "issue" &&
      error.code === "not_found"
        ? "issue_missing"
        : "issue_unreadable",
    issueNumber,
    section: null,
    line: null,
    details: { resource },
  };
}

const UNAVAILABLE_COMPLETION: CompletionEvidence = {
  completed: false,
  pullRequests: [],
};

function unavailableSelectedIssue(
  number: number,
  snapshot: IssueSnapshot | undefined,
): PlannedIssueV1 {
  return {
    number,
    nodeId: snapshot?.nodeId ?? null,
    title: snapshot?.title ?? null,
    url: snapshot?.url ?? null,
    state: snapshot?.state ?? null,
    labels: snapshot === undefined ? [] : normalizeLabels(snapshot.labels),
    updatedAt: snapshot?.updatedAt ?? null,
    completion: UNAVAILABLE_COMPLETION,
    graphNode: null,
  };
}

function unavailableBoundaryIssue(
  number: number,
  snapshot: IssueSnapshot | undefined,
): PlannedBoundaryIssueV1 {
  return {
    number,
    nodeId: snapshot?.nodeId ?? null,
    title: snapshot?.title ?? null,
    url: snapshot?.url ?? null,
    state: snapshot?.state ?? null,
    updatedAt: snapshot?.updatedAt ?? null,
    completion: UNAVAILABLE_COMPLETION,
    graphNode: null,
  };
}
