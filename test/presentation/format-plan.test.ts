import { describe, expect, test } from "vitest";

import type {
  CommandOutcome,
  PlanResultV1,
} from "../../src/planning/contracts.js";
import { formatPlanOutcome } from "../../src/presentation/format-plan.js";

describe("formatPlanOutcome", () => {
  test("should render a complete read-only planning report", () => {
    const rendered = formatPlanOutcome({ kind: "planned", plan: plan() });

    expect(rendered).toMatchObject({
      schemaVersion: 1,
      kind: "planned",
      truncated: false,
    });
    expect(rendered.text).toContain("Repository: acme/waves");
    expect(rendered.text).toContain("#1 [ready] Issue 1");
    expect(rendered.text).toContain("Level 1: [#1]");
    expect(rendered.text).toContain("No execution occurred.");
  });

  test("should render fatal outcomes without adapter internals", () => {
    const outcome: CommandOutcome = {
      kind: "fatal",
      code: "rate_limited",
      message: "GitHub rate limit reached\u001b[31m",
      retryAfterSeconds: 17,
    };

    const rendered = formatPlanOutcome(outcome);

    expect(rendered.text).toBe(
      "Waves plan failed [rate_limited]: GitHub rate limit reached\nRetry after: 17 seconds\n\nNo execution occurred.",
    );
    expect(rendered.text).not.toContain("\u001b");
  });

  test("should cap output by UTF-8 bytes and lines with an omission notice", () => {
    const oversizedPlan = plan({
      selected: Array.from({ length: 2_100 }, (_, index) => ({
        number: index + 1,
        nodeId: `issue-${index + 1}`,
        title: `Issue ${index + 1} ${"á".repeat(40)}`,
        url: `https://github.com/acme/waves/issues/${index + 1}`,
        state: "OPEN" as const,
        labels: ["agent: suitable"],
        updatedAt: "2026-01-01T00:00:00Z",
        completion: { completed: false, pullRequests: [] },
        graphNode: null,
      })),
      graph: null,
      runnable: false,
    });

    const rendered = formatPlanOutcome(
      { kind: "planned", plan: oversizedPlan },
      { maximumBytes: 50 * 1024, maximumLines: 2_000 },
    );

    expect(rendered.truncated).toBe(true);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(
      50 * 1024,
    );
    expect(rendered.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(rendered.text).toMatch(/Output truncated: \d+ lines omitted/u);
  });

  test("should render repeated plans deterministically", () => {
    const outcome: CommandOutcome = { kind: "planned", plan: plan() };

    expect(formatPlanOutcome(outcome)).toEqual(formatPlanOutcome(outcome));
  });
});

function plan(overrides: Partial<PlanResultV1> = {}): PlanResultV1 {
  return {
    plannerSchemaVersion: 1,
    repository: {
      nodeId: "repo-node",
      owner: "acme",
      name: "waves",
      url: "https://github.com/acme/waves",
      defaultBranch: "main",
      defaultBranchTipOid: "tip-oid",
    },
    inputOrder: [1],
    maxConcurrency: 3,
    selected: [
      {
        number: 1,
        nodeId: "issue-1",
        title: "Issue 1",
        url: "https://github.com/acme/waves/issues/1",
        state: "OPEN",
        labels: ["agent: suitable"],
        updatedAt: "2026-01-01T00:00:00Z",
        completion: { completed: false, pullRequests: [] },
        graphNode: {
          id: "issue-1",
          issueNumber: 1,
          disposition: "ready",
          level: 1,
          directBlockerNumbers: [],
          unresolvedBlockerNumbers: [],
        },
      },
    ],
    boundary: [],
    edges: [],
    graph: {
      schemaVersion: 1,
      runnable: true,
      selected: [
        {
          id: "issue-1",
          issueNumber: 1,
          disposition: "ready",
          level: 1,
          directBlockerNumbers: [],
          unresolvedBlockerNumbers: [],
        },
      ],
      boundary: [],
      edges: [],
      cycles: [],
      levels: [{ level: 1, batches: [[1]] }],
    },
    diagnostics: [],
    runnable: true,
    ...overrides,
  };
}
