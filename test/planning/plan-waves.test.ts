import { describe, expect, test, vi } from "vitest";

import type {
  ClosureEventPage,
  DependencyPage,
  GitHubReadPort,
  IssueSnapshot,
  RemoteRepositorySnapshot,
  RepositoryPort,
} from "../../src/planning/contracts.js";
import { AdapterError } from "../../src/planning/adapter-error.js";
import { planWaves } from "../../src/planning/plan-waves.js";

const VALID_BODY = `## Context
Context.
## Objective
Objective.
## Scope
Scope.
## Out of scope
Out.
## Expected behavior
Behavior.
## Technical notes
Notes.
## Acceptance criteria
- Accepted.
## Test scenarios
- Tested.
`;

const REMOTE_REPOSITORY: RemoteRepositorySnapshot = {
  nodeId: "repo-node",
  owner: "acme",
  name: "waves",
  url: "https://github.com/acme/waves",
  defaultBranch: "main",
  defaultBranchTipOid: "tip-oid",
};

describe("planWaves", () => {
  test("should reject an unsupported repository before checking authentication", async () => {
    const { ports } = fakePorts({
      issues: new Map(),
      repositoryError: new AdapterError(
        "unsupported_repository",
        "unsupported repository",
      ),
      authenticationError: new AdapterError(
        "not_authenticated",
        "not authenticated",
      ),
    });

    await expect(planWaves(input([1]), ports)).resolves.toEqual({
      kind: "fatal",
      code: "unsupported_repository",
      message: "unsupported repository",
      retryAfterSeconds: null,
    });
  });

  test("should propagate unexpected failures to the reporting boundary", async () => {
    const unexpectedError = new Error("unexpected repository failure");
    const { ports } = fakePorts({
      issues: new Map(),
      repositoryError: unexpectedError,
    });

    await expect(planWaves(input([1]), ports)).rejects.toBe(unexpectedError);
  });

  test("should build a deterministic graph when selected issues are eligible", async () => {
    const issues = new Map([
      [1, issue({ number: 1, nodeId: "issue-1" })],
      [2, issue({ number: 2, nodeId: "issue-2" })],
    ]);
    const { ports } = fakePorts({
      issues,
      dependencies: new Map([
        [
          2,
          [
            {
              repositoryUrl: "https://api.github.com/repos/acme/waves",
              repositoryOwner: "acme",
              repositoryName: "waves",
              issueNodeId: "issue-1",
              number: 1,
            },
          ],
        ],
      ]),
    });

    const outcome = await planWaves(
      {
        cwd: "/worktree",
        selection: {
          inputOrder: [2, 1],
          selectedNumbers: [1, 2],
          diagnostics: [],
        },
      },
      ports,
    );

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        plannerSchemaVersion: 1,
        inputOrder: [2, 1],
        maxConcurrency: 3,
        runnable: true,
        selected: [
          { number: 1, graphNode: { disposition: "ready", level: 1 } },
          {
            number: 2,
            graphNode: { disposition: "blocked_selected", level: 2 },
          },
        ],
        boundary: [],
        edges: [{ blockerNumber: 1, blockedNumber: 2 }],
        diagnostics: [],
        graph: {
          runnable: true,
          levels: [
            { level: 1, batches: [[1]] },
            { level: 2, batches: [[2]] },
          ],
        },
      },
    });
  });

  test("should block a selected issue when an open boundary blocker exists", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [2, issue({ number: 2, nodeId: "issue-2" })],
        [3, issue({ number: 3, nodeId: "issue-3", labels: [] })],
      ]),
      dependencies: new Map([
        [
          2,
          [
            {
              repositoryUrl: "https://api.github.com/repos/acme/waves",
              repositoryOwner: "acme",
              repositoryName: "waves",
              issueNodeId: "issue-3",
              number: 3,
            },
          ],
        ],
      ]),
    });

    const outcome = await planWaves(input([2]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        runnable: false,
        selected: [
          { number: 2, graphNode: { disposition: "blocked_external" } },
        ],
        boundary: [{ number: 3, graphNode: { status: "unresolved" } }],
        diagnostics: [
          expect.objectContaining({
            code: "external_blocker_open",
            issueNumber: 2,
            details: { blockerNumbers: "3" },
          }),
        ],
      },
    });
  });

  test("should classify malformed selected work as invalid", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [1, issue({ number: 1, nodeId: "issue-1", body: "No sections" })],
      ]),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        runnable: false,
        selected: [{ graphNode: { disposition: "invalid" } }],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "missing_section", issueNumber: 1 }),
        ]),
      },
    });
  });

  test("should stop traversal above a verified completion barrier", async () => {
    const blocker = issue({
      number: 3,
      nodeId: "issue-3",
      state: "CLOSED",
      labels: [],
      body: "",
    });
    const { ports, getBlockedBy } = fakePorts({
      issues: new Map([
        [2, issue({ number: 2, nodeId: "issue-2" })],
        [3, blocker],
      ]),
      dependencies: new Map([
        [
          2,
          [
            {
              repositoryUrl: "https://api.github.com/repos/acme/waves",
              repositoryOwner: "acme",
              repositoryName: "waves",
              issueNodeId: "issue-3",
              number: 3,
            },
          ],
        ],
      ]),
      closures: new Map([
        [
          3,
          [
            {
              kind: "closed" as const,
              nodeId: "closed-event",
              createdAt: "2026-01-02T00:00:00Z",
              closer: {
                nodeId: "pr-node",
                repositoryNodeId: "repo-node",
                repositoryOwner: "acme",
                repositoryName: "waves",
                number: 30,
                url: "https://github.com/acme/waves/pull/30",
                mergedAt: "2026-01-02T00:00:00Z",
                mergeCommitOid: "merge-oid",
                baseBranch: "main",
              },
            },
          ],
        ],
      ]),
    });

    const outcome = await planWaves(input([2]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        runnable: true,
        selected: [{ graphNode: { disposition: "ready" } }],
        boundary: [
          {
            number: 3,
            completion: { completed: true },
            graphNode: { status: "complete" },
          },
        ],
      },
    });
    expect(getBlockedBy).not.toHaveBeenCalledWith(
      "acme",
      "waves",
      3,
      expect.any(Number),
    );
  });

  test("should ignore closing pull requests from before the final reopen", async () => {
    const { ports, compareCommits } = fakePorts({
      issues: new Map([
        [
          3,
          issue({ number: 3, nodeId: "issue-3", state: "CLOSED", body: "" }),
        ],
      ]),
      closures: new Map([
        [
          3,
          [
            closedByPullRequest({ number: 30, nodeId: "pr-before-reopen" }),
            {
              kind: "reopened" as const,
              nodeId: "reopened-event",
              createdAt: "2026-01-03T00:00:00Z",
            },
            {
              kind: "closed" as const,
              nodeId: "manual-close",
              createdAt: "2026-01-04T00:00:00Z",
              closer: null,
            },
          ],
        ],
      ]),
    });

    const outcome = await planWaves(input([3]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        runnable: false,
        selected: [
          {
            number: 3,
            completion: { completed: false, pullRequests: [] },
            graphNode: { disposition: "invalid" },
          },
        ],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "issue_closed_uncompleted" }),
        ]),
      },
    });
    expect(compareCommits).not.toHaveBeenCalled();
  });

  test("should aggregate ticket and label failures for closed uncompleted work", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [
          3,
          issue({
            number: 3,
            nodeId: "issue-3",
            state: "CLOSED",
            labels: [],
            body: "",
          }),
        ],
      ]),
    });

    const outcome = await planWaves(input([3]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "issue_closed_uncompleted" }),
          expect.objectContaining({ code: "label_missing" }),
          expect.objectContaining({ code: "missing_section" }),
        ]),
      },
    });
  });

  test("should classify only reachable current-default-branch pull requests as completion", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [
          3,
          issue({ number: 3, nodeId: "issue-3", state: "CLOSED", body: "" }),
        ],
      ]),
      closures: new Map([
        [
          3,
          [
            closedByPullRequest({ number: 31, baseBranch: "release" }),
            closedByPullRequest({ number: 32, mergeCommitOid: null }),
            closedByPullRequest({ number: 33 }),
          ],
        ],
      ]),
      comparisonStatuses: new Map([["merge-33", "diverged"]]),
    });

    const outcome = await planWaves(input([3]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        selected: [
          {
            completion: {
              completed: false,
              pullRequests: [
                { number: 31, reachable: false },
                { number: 33, reachable: false },
              ],
            },
          },
        ],
      },
    });
  });

  test("should preserve authorization failures from completion comparison", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [
          3,
          issue({ number: 3, nodeId: "issue-3", state: "CLOSED", body: "" }),
        ],
      ]),
      closures: new Map([[3, [closedByPullRequest({ number: 33 })]]]),
      comparisonErrors: new Map([
        ["merge-33", new AdapterError("forbidden", "comparison forbidden")],
      ]),
    });

    await expect(planWaves(input([3]), ports)).resolves.toEqual({
      kind: "fatal",
      code: "forbidden",
      message: "comparison forbidden",
      retryAfterSeconds: null,
    });
  });

  test("should add none of a parent's boundary nodes when its batch exceeds the limit", async () => {
    const dependencies = Array.from({ length: 201 }, (_, index) => ({
      repositoryUrl: "https://api.github.com/repos/acme/waves",
      repositoryOwner: "acme",
      repositoryName: "waves",
      issueNodeId: `issue-${index + 2}`,
      number: index + 2,
    }));
    const { ports } = fakePorts({
      issues: new Map([[1, issue({ number: 1, nodeId: "issue-1" })]]),
      dependencies: new Map([[1, dependencies]]),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        graph: null,
        runnable: false,
        boundary: [],
        edges: [],
        diagnostics: [
          expect.objectContaining({
            code: "boundary_limit_exceeded",
            issueNumber: 1,
            details: { parentIssueNumber: 1, attemptedTotal: 201, maximum: 200 },
          }),
        ],
      },
    });
  });

  test("should stop dependency pagination once page three proves the boundary limit", async () => {
    const page = (pageNumber: number) =>
      Array.from({ length: 100 }, (_, index) =>
        dependencySnapshot((pageNumber - 1) * 100 + index + 2),
      );
    const { ports } = fakePorts({
      issues: new Map([[1, issue({ number: 1, nodeId: "issue-1" })]]),
      dependencyPage: (_number, pageNumber) => {
        if (pageNumber > 3) {
          throw new AdapterError("process_failed", "unexpected fourth page");
        }
        return {
          dependencies: page(pageNumber),
          page: pageNumber,
          hasNextPage: true,
        };
      },
    });

    await expect(planWaves(input([1]), ports)).resolves.toMatchObject({
      kind: "planned",
      plan: {
        graph: null,
        boundary: [],
        diagnostics: [
          expect.objectContaining({
            code: "boundary_limit_exceeded",
            details: { parentIssueNumber: 1, attemptedTotal: 300, maximum: 200 },
          }),
        ],
      },
    });
  });

  test("should keep reportable issue failures in a non-runnable plan", async () => {
    const { ports } = fakePorts({
      issues: new Map(),
      issueErrors: new Map([
        [1, new AdapterError("not_found", "issue unavailable")],
      ]),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        graph: null,
        runnable: false,
        selected: [
          {
            number: 1,
            nodeId: null,
            title: null,
            url: null,
            state: null,
            graphNode: null,
          },
        ],
        diagnostics: [
          {
            severity: "error",
            code: "issue_missing",
            issueNumber: 1,
            section: null,
            line: null,
            details: { resource: "issue" },
          },
        ],
      },
    });
  });

  test("should return no partial plan for fatal adapter failures", async () => {
    const { ports } = fakePorts({
      issues: new Map(),
      issueErrors: new Map([
        [1, new AdapterError("rate_limited", "GitHub rate limit reached", 42)],
      ]),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toEqual({
      kind: "fatal",
      code: "rate_limited",
      message: "GitHub rate limit reached",
      retryAfterSeconds: 42,
    });
  });

  test("should preserve a safe issue snapshot when closure evidence is unreadable", async () => {
    const { ports } = fakePorts({
      issues: new Map([
        [1, issue({ number: 1, nodeId: "issue-1", state: "CLOSED" })],
      ]),
      closureErrors: new Map([
        [1, new AdapterError("forbidden", "closure unavailable")],
      ]),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        graph: null,
        selected: [
          {
            number: 1,
            nodeId: "issue-1",
            title: "Issue 1",
            state: "CLOSED",
            graphNode: null,
          },
        ],
        diagnostics: [
          expect.objectContaining({
            code: "issue_unreadable",
            details: { resource: "closure" },
          }),
        ],
      },
    });
  });

  test("should return a resource-limit fatal when closure pagination exceeds 1000 events", async () => {
    const events = Array.from({ length: 100 }, (_, index) => ({
      kind: "reopened" as const,
      nodeId: `event-${index}`,
      createdAt: "2026-01-02T00:00:00Z",
    }));
    const { ports } = fakePorts({
      issues: new Map([
        [
          1,
          issue({ number: 1, nodeId: "issue-1", state: "CLOSED", body: "" }),
        ],
      ]),
      closurePage: (_number, cursor) => ({
        events,
        hasNextPage: true,
        endCursor: String(Number(cursor ?? "0") + 1),
      }),
    });

    const outcome = await planWaves(input([1]), ports);

    expect(outcome).toEqual({
      kind: "fatal",
      code: "resource_limit",
      message: "closure event limit exceeded",
      retryAfterSeconds: null,
    });
  });

  test("should emit a cycle diagnostic for selected dependency cycles", async () => {
    const dependency = (number: number) => ({
      repositoryUrl: "https://api.github.com/repos/acme/waves",
      repositoryOwner: "acme",
      repositoryName: "waves",
      issueNodeId: `issue-${number}`,
      number,
    });
    const { ports } = fakePorts({
      issues: new Map([
        [1, issue({ number: 1, nodeId: "issue-1" })],
        [2, issue({ number: 2, nodeId: "issue-2" })],
      ]),
      dependencies: new Map([
        [1, [dependency(2)]],
        [2, [dependency(1)]],
      ]),
    });

    const outcome = await planWaves(input([2, 1]), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        runnable: false,
        diagnostics: [
          expect.objectContaining({
            code: "dependency_cycle",
            details: { issueNumbers: "1,2" },
          }),
        ],
      },
    });
  });

  test("should produce the same plan regardless of dependency response order", async () => {
    const dependencies = [
      dependencySnapshot(3),
      dependencySnapshot(2),
    ];
    const issues = new Map([
      [1, issue({ number: 1, nodeId: "issue-1" })],
      [2, issue({ number: 2, nodeId: "issue-2" })],
      [3, issue({ number: 3, nodeId: "issue-3" })],
    ]);
    const forward = fakePorts({
      issues,
      dependencies: new Map([[1, dependencies]]),
    });
    const reverse = fakePorts({
      issues,
      dependencies: new Map([[1, [...dependencies].reverse()]]),
    });

    const [forwardOutcome, reverseOutcome] = await Promise.all([
      planWaves(input([1]), forward.ports),
      planWaves(input([1]), reverse.ports),
    ]);

    expect(forwardOutcome).toEqual(reverseOutcome);
  });

  test("should load each breadth level in issue-number order", async () => {
    const { ports, getIssue } = fakePorts({
      issues: new Map(
        [2, 10, 20, 100].map((number) => [
          number,
          issue({ number, nodeId: `issue-${number}` }),
        ]),
      ),
      dependencies: new Map([
        [10, [dependencySnapshot(100)]],
        [20, [dependencySnapshot(2)]],
      ]),
    });

    await planWaves(input([10, 20]), ports);

    expect(getIssue.mock.calls.map((call) => call[2])).toEqual([10, 20, 2, 100]);
  });

  test("should add none of a parent's edges when its batch exceeds the edge limit", async () => {
    const selectedNumbers = Array.from({ length: 50 }, (_, index) => index + 1);
    const boundaryNumbers = Array.from(
      { length: 200 },
      (_, index) => index + 51,
    );
    const issues = new Map(
      [...selectedNumbers, ...boundaryNumbers].map((number) => [
        number,
        issue({ number, nodeId: `issue-${number}` }),
      ]),
    );
    const dependencies = new Map<number, DependencyPage["dependencies"]>();
    for (const number of selectedNumbers) {
      dependencies.set(
        number,
        boundaryNumbers.map(dependencySnapshot),
      );
    }
    dependencies.set(50, [
      dependencySnapshot(1),
      ...boundaryNumbers.map(dependencySnapshot),
    ]);
    const { ports } = fakePorts({ issues, dependencies });

    const outcome = await planWaves(input(selectedNumbers), ports);

    expect(outcome).toMatchObject({
      kind: "planned",
      plan: {
        graph: null,
        runnable: false,
        edges: { length: 9_800 },
        diagnostics: [
          expect.objectContaining({
            code: "edge_limit_exceeded",
            issueNumber: 50,
            details: {
              parentIssueNumber: 50,
              attemptedTotal: 10_001,
              maximum: 10_000,
            },
          }),
        ],
      },
    });
  });
});

function input(selectedNumbers: readonly number[]) {
  return {
    cwd: "/worktree",
    selection: { inputOrder: selectedNumbers, selectedNumbers, diagnostics: [] },
  } as const;
}

function issue(
  overrides: Partial<IssueSnapshot> & Pick<IssueSnapshot, "number" | "nodeId">,
): IssueSnapshot {
  const { nodeId, number, ...optionalOverrides } = overrides;
  return {
    nodeId,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/waves/issues/${number}`,
    state: "OPEN",
    labels: ["agent: suitable"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    body: VALID_BODY,
    ...optionalOverrides,
  };
}

function fakePorts(options: {
  readonly issues: ReadonlyMap<number, IssueSnapshot>;
  readonly repositoryError?: unknown;
  readonly authenticationError?: AdapterError;
  readonly dependencies?: ReadonlyMap<number, DependencyPage["dependencies"]>;
  readonly dependencyPage?: (
    number: number,
    page: number,
  ) => DependencyPage;
  readonly closures?: ReadonlyMap<number, ClosureEventPage["events"]>;
  readonly issueErrors?: ReadonlyMap<number, AdapterError>;
  readonly closureErrors?: ReadonlyMap<number, AdapterError>;
  readonly closurePage?: (
    number: number,
    cursor: string | null,
  ) => ClosureEventPage;
  readonly comparisonStatuses?: ReadonlyMap<
    string,
    "ahead" | "behind" | "diverged" | "identical"
  >;
  readonly comparisonErrors?: ReadonlyMap<string, AdapterError>;
}) {
  const repository: RepositoryPort = {
    discover: vi.fn(async () => {
      if (options.repositoryError !== undefined) throw options.repositoryError;
      return {
        worktreeRoot: "/worktree",
        commonDir: "/repo/.git",
        originUrl: "git@github.com:acme/waves.git",
        owner: "acme",
        name: "waves",
      };
    }),
  };
  const getBlockedBy = vi.fn(
    async (_owner: string, _name: string, number: number, page: number) =>
      options.dependencyPage?.(number, page) ?? {
        dependencies:
          page === 1 ? (options.dependencies?.get(number) ?? []) : [],
        page,
        hasNextPage: false,
      },
  );
  const getIssue = vi.fn(async (_owner: string, _name: string, number: number) => {
    const error = options.issueErrors?.get(number);
    if (error !== undefined) throw error;
    const snapshot = options.issues.get(number);
    if (snapshot === undefined) throw new Error(`Missing fixture #${number}`);
    return snapshot;
  });
  const github: GitHubReadPort = {
    authenticate: vi.fn(async () => {
      if (options.authenticationError !== undefined) {
        throw options.authenticationError;
      }
    }),
    getRepository: vi.fn(async () => REMOTE_REPOSITORY),
    getIssue,
    getBlockedBy,
    getClosureEvents: vi.fn(async (_owner, _name, number, cursor) => {
      const error = options.closureErrors?.get(number);
      if (error !== undefined) throw error;
      return (
        options.closurePage?.(number, cursor) ?? {
          events: options.closures?.get(number) ?? [],
          hasNextPage: false,
          endCursor: null,
        }
      );
    }),
    compareCommits: vi.fn(async (_owner, _name, baseOid) => {
      const error = options.comparisonErrors?.get(baseOid);
      if (error !== undefined) throw error;
      return { status: options.comparisonStatuses?.get(baseOid) ?? "ahead" };
    }),
  };

  return {
    ports: { repository, github },
    getBlockedBy,
    getIssue,
    compareCommits: github.compareCommits,
  };
}

function dependencySnapshot(number: number): DependencyPage["dependencies"][number] {
  return {
    repositoryUrl: "https://api.github.com/repos/acme/waves",
    repositoryOwner: "acme",
    repositoryName: "waves",
    issueNodeId: `issue-${number}`,
    number,
  };
}

function closedByPullRequest(
  overrides: Partial<
    Extract<ClosureEventPage["events"][number], { kind: "closed" }>["closer"] &
      { readonly number: number }
  >,
): Extract<ClosureEventPage["events"][number], { kind: "closed" }> {
  const number = overrides.number ?? 30;
  return {
    kind: "closed",
    nodeId: `closed-${number}`,
    createdAt: "2026-01-02T00:00:00Z",
    closer: {
      nodeId: `pr-${number}`,
      repositoryNodeId: "repo-node",
      repositoryOwner: "acme",
      repositoryName: "waves",
      number,
      url: `https://github.com/acme/waves/pull/${number}`,
      mergedAt: "2026-01-02T00:00:00Z",
      mergeCommitOid: `merge-${number}`,
      baseBranch: "main",
      ...overrides,
    },
  };
}
