import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  createGitHubReadPort,
  type GitHubCliOptions,
} from "../../src/adapters/github-cli.js";
import type {
  ProcessResult,
  ProcessRunner,
} from "../../src/adapters/run-process.js";

const argvSchema = z.array(z.string());

describe("createGitHubReadPort", () => {
  test("should authenticate against github.com without exposing credentials", async () => {
    const runner = fixedRunner({ exitCode: 0, stdout: "", stderr: "" });

    await port(runner).authenticate();

    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      expect.any(Object),
    );
  });

  test("should load repository identity and its default tip", async () => {
    const runner = sequenceRunner([
      jsonResult({
        node_id: "repo-node",
        owner: { login: "acme" },
        name: "waves",
        html_url: "https://github.com/acme/waves",
        default_branch: "main",
      }),
      jsonResult({ sha: "tip-oid" }),
    ]);

    const result = await port(runner).getRepository("acme", "waves");

    expect(result).toEqual({
      nodeId: "repo-node",
      owner: "acme",
      name: "waves",
      url: "https://github.com/acme/waves",
      defaultBranch: "main",
      defaultBranchTipOid: "tip-oid",
    });
    expect(runner.mock.calls[1]?.[1]).toContain(
      "/repos/acme/waves/commits/main",
    );
  });

  test("should validate and normalize an issue snapshot", async () => {
    const runner = fixedRunner(
      jsonResult({
        node_id: "issue-node",
        number: 7,
        title: "Safe issue",
        html_url: "https://github.com/acme/waves/issues/7",
        state: "open",
        labels: [{ name: "agent: suitable" }],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        body: null,
      }),
    );

    await expect(port(runner).getIssue("acme", "waves", 7)).resolves.toEqual({
      nodeId: "issue-node",
      number: 7,
      title: "Safe issue",
      url: "https://github.com/acme/waves/issues/7",
      state: "OPEN",
      labels: ["agent: suitable"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      body: "",
    });
  });

  test.each(["created_at", "updated_at"] as const)(
    "should reject a malformed issue %s timestamp",
    async (field) => {
      const issue = {
        node_id: "issue-node",
        number: 7,
        title: "Safe issue",
        html_url: "https://github.com/acme/waves/issues/7",
        state: "open",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00+02:00",
        body: "",
        [field]: "not-a-date-time",
      };

      await expect(
        port(fixedRunner(jsonResult(issue))).getIssue("acme", "waves", 7),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  test("should reject an issue response for a different number", async () => {
    const runner = fixedRunner(
      jsonResult({
        node_id: "issue-2",
        number: 2,
        title: "Different issue",
        html_url: "https://github.com/acme/waves/issues/2",
        state: "open",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        body: "",
      }),
    );

    await expect(port(runner).getIssue("acme", "waves", 1)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("should parse native dependency pages and detect a full page", async () => {
    const dependencies = Array.from({ length: 100 }, (_, index) => ({
      repository_url: "https://api.github.com/repos/acme/waves",
      node_id: `issue-${index + 1}`,
      number: index + 1,
    }));
    const runner = fixedRunner(jsonResult(dependencies));

    const result = await port(runner).getBlockedBy("acme", "waves", 7, 2);

    expect(result).toMatchObject({ page: 2, hasNextPage: true });
    expect(result.dependencies[0]).toEqual({
      repositoryUrl: "https://api.github.com/repos/acme/waves",
      repositoryOwner: "acme",
      repositoryName: "waves",
      issueNodeId: "issue-1",
      number: 1,
    });
    expect(runner.mock.calls[0]?.[1]).toContain(
      "/repos/acme/waves/issues/7/dependencies/blocked_by?per_page=100&page=2",
    );
    expect(runner.mock.calls[0]?.[1]).toContain("--jq");
  });

  test("should preserve closure connection order and pull request evidence", async () => {
    const runner = fixedRunner(
      jsonResult({
        data: {
          repository: {
            issue: {
              timelineItems: {
                nodes: [
                  {
                    __typename: "ReopenedEvent",
                    id: "reopen",
                    createdAt: "2026-01-02T00:00:00Z",
                  },
                  {
                    __typename: "ClosedEvent",
                    id: "close",
                    createdAt: "2026-01-03T00:00:00Z",
                    closer: {
                      __typename: "PullRequest",
                      id: "pr-node",
                      number: 10,
                      url: "https://github.com/acme/waves/pull/10",
                      mergedAt: "2026-01-03T00:00:00Z",
                      mergeCommit: { oid: "merge-oid" },
                      baseRefName: "main",
                      repository: {
                        id: "repo-node",
                        name: "waves",
                        owner: { login: "acme" },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              },
            },
          },
        },
      }),
    );

    const result = await port(runner).getClosureEvents(
      "acme",
      "waves",
      7,
      "cursor-1",
    );

    expect(result).toEqual({
      events: [
        {
          kind: "reopened",
          nodeId: "reopen",
          createdAt: "2026-01-02T00:00:00Z",
        },
        {
          kind: "closed",
          nodeId: "close",
          createdAt: "2026-01-03T00:00:00Z",
          closer: {
            nodeId: "pr-node",
            repositoryNodeId: "repo-node",
            repositoryOwner: "acme",
            repositoryName: "waves",
            number: 10,
            url: "https://github.com/acme/waves/pull/10",
            mergedAt: "2026-01-03T00:00:00Z",
            mergeCommitOid: "merge-oid",
            baseBranch: "main",
          },
        },
      ],
      hasNextPage: true,
      endCursor: "cursor-2",
    });
    expect(runner.mock.calls[0]?.[1]).toContain("after=cursor-1");
  });

  test.each([
    [
      "ReopenedEvent",
      { __typename: "ReopenedEvent", id: "reopen", createdAt: "invalid" },
    ],
    [
      "ClosedEvent",
      {
        __typename: "ClosedEvent",
        id: "close",
        createdAt: "invalid",
        closer: null,
      },
    ],
  ] as const)("should reject a malformed %s timestamp", async (_kind, event) => {
    const response = {
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [event],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };

    await expect(
      port(fixedRunner(jsonResult(response))).getClosureEvents(
        "acme",
        "waves",
        7,
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("should reject a malformed merged timestamp", async () => {
    const response = {
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: "ClosedEvent",
                  id: "close",
                  createdAt: "2026-01-03T00:00:00Z",
                  closer: {
                    __typename: "PullRequest",
                    id: "pr-node",
                    number: 10,
                    url: "https://github.com/acme/waves/pull/10",
                    mergedAt: "invalid",
                    mergeCommit: { oid: "merge-oid" },
                    baseRefName: "main",
                    repository: {
                      id: "repo-node",
                      name: "waves",
                      owner: { login: "acme" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };

    await expect(
      port(fixedRunner(jsonResult(response))).getClosureEvents(
        "acme",
        "waves",
        7,
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("should compare the merge OID as base and default tip as head", async () => {
    const runner = fixedRunner(jsonResult({ status: "identical" }));

    await expect(
      port(runner).compareCommits("acme", "waves", "merge-oid", "tip-oid"),
    ).resolves.toEqual({ status: "identical" });
    expect(runner.mock.calls[0]?.[1]).toContain(
      "/repos/acme/waves/compare/merge-oid...tip-oid",
    );
  });

  test("should reject malformed API JSON at the adapter boundary", async () => {
    const runner = fixedRunner({ exitCode: 0, stdout: "not-json", stderr: "" });

    await expect(port(runner).getIssue("acme", "waves", 1)).rejects.toMatchObject(
      { code: "invalid_response", message: "GitHub returned malformed JSON" },
    );
  });

  test.each([
    [401, "not_authenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [410, "gone"],
    [429, "rate_limited"],
    [500, "network"],
  ] as const)("should map HTTP %i to %s", async (status, code) => {
    const runner = fixedRunner({
      exitCode: 1,
      stdout: "",
      stderr: `gh: request failed (HTTP ${status})`,
    });

    await expect(port(runner).getIssue("acme", "waves", 1)).rejects.toMatchObject({
      code,
    });
  });

  test("should retain only rate-limit headers needed for a retry", async () => {
    const runner = fixedRunner({
      exitCode: 1,
      stdout: [
        "HTTP/2.0 403 Forbidden",
        "Authorization: secret-token",
        "X-RateLimit-Remaining: 0",
        "Retry-After: 17",
        "",
        "sensitive body",
      ].join("\r\n"),
      stderr: "gh: rate limit (HTTP 403)",
    });

    await expect(port(runner).getIssue("acme", "waves", 1)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 17,
      message: "GitHub rate limit reached",
    });
  });

  test("should restrict every GitHub operation to read-only API requests", async () => {
    const runner = sequenceRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      jsonResult({
        node_id: "repo-node",
        owner: { login: "acme" },
        name: "waves",
        html_url: "https://github.com/acme/waves",
        default_branch: "main",
      }),
      jsonResult({ sha: "tip-oid" }),
      jsonResult({
        node_id: "issue-node",
        number: 7,
        title: "Safe issue",
        html_url: "https://github.com/acme/waves/issues/7",
        state: "open",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        body: "",
      }),
      jsonResult([]),
      jsonResult({
        data: {
          repository: {
            issue: {
              timelineItems: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      jsonResult({ status: "ahead" }),
    ]);
    const github = port(runner);

    await github.authenticate();
    await github.getRepository("acme", "waves");
    await github.getIssue("acme", "waves", 7);
    await github.getBlockedBy("acme", "waves", 7, 1);
    await github.getClosureEvents("acme", "waves", 7, null);
    await github.compareCommits("acme", "waves", "base", "head");

    expect(
      runner.mock.calls
        .map((call) => call[1])
        .filter((args) => args[0] === "api")
        .map((args) =>
          args[1] === "graphql"
            ? {
                kind: "graphql",
                operation: args
                  .find((argument) => argument.startsWith("query="))
                  ?.slice(0, 11),
              }
            : {
                kind: "rest",
                method: args[args.indexOf("--method") + 1],
                endpoint: args.at(-1),
              },
        ),
    ).toEqual([
      { kind: "rest", method: "GET", endpoint: "/repos/acme/waves" },
      {
        kind: "rest",
        method: "GET",
        endpoint: "/repos/acme/waves/commits/main",
      },
      {
        kind: "rest",
        method: "GET",
        endpoint: "/repos/acme/waves/issues/7",
      },
      {
        kind: "rest",
        method: "GET",
        endpoint:
          "/repos/acme/waves/issues/7/dependencies/blocked_by?per_page=100&page=1",
      },
      { kind: "graphql", operation: "query=query" },
      {
        kind: "rest",
        method: "GET",
        endpoint: "/repos/acme/waves/compare/base...head",
      },
    ]);
  });

  test("should invoke a fake gh executable with safe argv", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "waves-gh-"));
    const recordPath = join(temporaryDirectory, "calls.jsonl");
    const environment = {
      ...process.env,
      WAVES_TEST_RECORD: recordPath,
      WAVES_TEST_RESULTS: JSON.stringify([jsonResult({ status: "ahead" })]),
    };

    try {
      const executable = fileURLToPath(
        new URL("../fixtures/bin/fake-cli.mjs", import.meta.url),
      );
      const github = createGitHubReadPort({
        ghExecutable: executable,
        environment,
      });

      await github.compareCommits("acme", "waves", "base", "head");

      const calls = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => argvSchema.parse(JSON.parse(line) as unknown));
      expect(calls).toEqual([
        expect.arrayContaining([
          "--method",
          "GET",
          "/repos/acme/waves/compare/base...head",
        ]),
      ]);
    } finally {
      await rm(temporaryDirectory, { recursive: true });
    }
  });
});

function port(runner: ReturnType<typeof fixedRunner>) {
  return createGitHubReadPort({ runner } satisfies GitHubCliOptions);
}

function jsonResult(value: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fixedRunner(result: ProcessResult) {
  return vi.fn<ProcessRunner>(async () => result);
}

function sequenceRunner(results: readonly ProcessResult[]) {
  let index = 0;
  return vi.fn<ProcessRunner>(async () => {
    const result = results[index];
    index += 1;
    if (result === undefined) throw new Error("unexpected process call");
    return result;
  });
}
