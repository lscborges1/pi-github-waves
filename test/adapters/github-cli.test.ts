import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGitHubReadPort,
  type GitHubCliOptions,
} from "../../src/adapters/github-cli.js";
import type {
  ProcessResult,
  ProcessRunner,
} from "../../src/adapters/run-process.js";

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

  test("should use only read endpoints and an explicit GraphQL query", async () => {
    const runner = fixedRunner(jsonResult({ status: "ahead" }));

    await port(runner).compareCommits("owner", "repo", "base", "head");

    const argv = runner.mock.calls[0]?.[1] ?? [];
    expect(argv).toContain("GET");
    expect(argv.join(" ")).not.toMatch(/delete|patch|mutation/iu);
  });

  test("should invoke a fake gh executable with safe argv", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "waves-gh-"));
    const recordPath = join(temporaryDirectory, "calls.jsonl");
    const previousRecord = process.env.WAVES_TEST_RECORD;
    const previousResults = process.env.WAVES_TEST_RESULTS;
    process.env.WAVES_TEST_RECORD = recordPath;
    process.env.WAVES_TEST_RESULTS = JSON.stringify([
      jsonResult({ status: "ahead" }),
    ]);

    try {
      const executable = fileURLToPath(
        new URL("../fixtures/bin/fake-cli.mjs", import.meta.url),
      );
      const github = createGitHubReadPort({ ghExecutable: executable });

      await github.compareCommits("acme", "waves", "base", "head");

      const calls = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      expect(calls).toEqual([
        expect.arrayContaining([
          "--method",
          "GET",
          "/repos/acme/waves/compare/base...head",
        ]),
      ]);
    } finally {
      restoreEnvironment("WAVES_TEST_RECORD", previousRecord);
      restoreEnvironment("WAVES_TEST_RESULTS", previousResults);
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
