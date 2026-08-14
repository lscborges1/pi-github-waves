import { z } from "zod";

import { AdapterError } from "../planning/adapter-error.js";
import type {
  ClosureEventPage,
  ClosureEventSnapshot,
  CommitComparisonSnapshot,
  DependencyPage,
  DependencySnapshot,
  GitHubReadPort,
  IssueSnapshot,
  PullRequestCloserSnapshot,
  RemoteRepositorySnapshot,
} from "../planning/contracts.js";
import {
  runProcess,
  type ProcessLogger,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from "./run-process.js";

const API_VERSION_HEADER = "X-GitHub-Api-Version: 2026-03-10";
const DEPENDENCY_PROJECTION =
  "[.[] | {repository_url: .repository_url, node_id: .node_id, number: .number}]";
const CLOSURE_QUERY = `query WavesClosureEvents($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
        nodes {
          __typename
          ... on ReopenedEvent { id createdAt }
          ... on ClosedEvent {
            id
            createdAt
            closer {
              __typename
              ... on PullRequest {
                id
                number
                url
                mergedAt
                mergeCommit { oid }
                baseRefName
                repository { id name owner { login } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const repositorySchema = z.object({
  node_id: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  name: z.string().min(1),
  html_url: z.string().url(),
  default_branch: z.string().min(1),
});
const commitSchema = z.object({ sha: z.string().min(1) });
const issueSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
});
const dependencySchema = z.object({
  repository_url: z.string().url(),
  node_id: z.string().min(1),
  number: z.number().int().positive(),
});
const dependencyPageSchema = z.array(dependencySchema).max(100);
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
});
const pullRequestCloserSchema = z.object({
  __typename: z.literal("PullRequest"),
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  mergedAt: z.string().min(1).nullable(),
  mergeCommit: z.object({ oid: z.string().min(1) }).nullable(),
  baseRefName: z.string().min(1),
  repository: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
});
const closureResponseSchema = z.object({
  data: z.object({
    repository: z
      .object({
        issue: z
          .object({
            timelineItems: z.object({
              nodes: z.array(
                z.discriminatedUnion("__typename", [
                  z.object({
                    __typename: z.literal("ReopenedEvent"),
                    id: z.string().min(1),
                    createdAt: z.string().min(1),
                  }),
                  z.object({
                    __typename: z.literal("ClosedEvent"),
                    id: z.string().min(1),
                    createdAt: z.string().min(1),
                    closer: z.unknown().nullable(),
                  }),
                ]),
              ),
              pageInfo: z.object({
                hasNextPage: z.boolean(),
                endCursor: z.string().min(1).nullable(),
              }),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

export interface GitHubCliOptions {
  readonly runner?: ProcessRunner;
  readonly ghExecutable?: string;
  readonly signal?: AbortSignal;
  readonly logger?: ProcessLogger;
}

export function createGitHubReadPort(
  options: GitHubCliOptions = {},
): GitHubReadPort {
  const runner = options.runner ?? runProcess;
  const executable = options.ghExecutable ?? "gh";
  const processOptions: RunProcessOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };

  const invoke = async (args: readonly string[]): Promise<unknown> => {
    const result = await runner(executable, args, processOptions);
    return parseGitHubJson(result);
  };
  const rest = (
    endpoint: string,
    additionalArgs: readonly string[] = [],
  ): Promise<unknown> =>
    invoke([
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      "GET",
      "--header",
      API_VERSION_HEADER,
      ...additionalArgs,
      endpoint,
    ]);

  return {
    async authenticate(): Promise<void> {
      const result = await runner(
        executable,
        ["auth", "status", "--hostname", "github.com"],
        processOptions,
      );
      if (result.exitCode !== 0) {
        throw new AdapterError(
          "not_authenticated",
          "GitHub CLI is not authenticated for github.com",
        );
      }
    },

    async getRepository(owner, name): Promise<RemoteRepositorySnapshot> {
      const repository = parseSchema(
        repositorySchema,
        await rest(`/repos/${path(owner)}/${path(name)}`),
      );
      const tip = parseSchema(
        commitSchema,
        await rest(
          `/repos/${path(owner)}/${path(name)}/commits/${path(
            repository.default_branch,
          )}`,
        ),
      );
      return {
        nodeId: repository.node_id,
        owner: repository.owner.login,
        name: repository.name,
        url: repository.html_url,
        defaultBranch: repository.default_branch,
        defaultBranchTipOid: tip.sha,
      };
    },

    async getIssue(owner, name, number): Promise<IssueSnapshot> {
      const issue = parseSchema(
        issueSchema,
        await rest(`/repos/${path(owner)}/${path(name)}/issues/${number}`),
      );
      if (issue.pull_request !== undefined) {
        throw new AdapterError(
          "invalid_response",
          "GitHub returned a pull request where an issue was required",
        );
      }
      return {
        nodeId: issue.node_id,
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state === "open" ? "OPEN" : "CLOSED",
        labels: issue.labels.map((label) => label.name),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        body: issue.body ?? "",
      };
    },

    async getBlockedBy(owner, name, number, page): Promise<DependencyPage> {
      const rawDependencies = parseSchema(
        dependencyPageSchema,
        await rest(
          `/repos/${path(owner)}/${path(name)}/issues/${number}/dependencies/blocked_by?per_page=100&page=${page}`,
          ["--jq", DEPENDENCY_PROJECTION],
        ),
      );
      const dependencies = rawDependencies.map(parseDependency);
      return {
        dependencies,
        page,
        hasNextPage: dependencies.length === 100,
      };
    },

    async getClosureEvents(owner, name, number, cursor): Promise<ClosureEventPage> {
      const args = [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--include",
        "--header",
        API_VERSION_HEADER,
        "--raw-field",
        `query=${CLOSURE_QUERY}`,
        "--raw-field",
        `owner=${owner}`,
        "--raw-field",
        `name=${name}`,
        "--field",
        `number=${number}`,
        ...(cursor === null
          ? []
          : ["--raw-field", `after=${cursor}`]),
      ];
      const response = parseSchema(closureResponseSchema, await invoke(args));
      const timeline = response.data.repository?.issue?.timelineItems;
      if (timeline === undefined) {
        throw new AdapterError("not_found", "GitHub issue was not found");
      }
      const events: ClosureEventSnapshot[] = timeline.nodes.map((event) => {
        if (event.__typename === "ReopenedEvent") {
          return {
            kind: "reopened",
            nodeId: event.id,
            createdAt: event.createdAt,
          };
        }
        return {
          kind: "closed",
          nodeId: event.id,
          createdAt: event.createdAt,
          closer: parsePullRequestCloser(event.closer),
        };
      });
      return {
        events,
        hasNextPage: timeline.pageInfo.hasNextPage,
        endCursor: timeline.pageInfo.endCursor,
      };
    },

    async compareCommits(owner, name, baseOid, headOid): Promise<CommitComparisonSnapshot> {
      try {
        return parseSchema(
          comparisonSchema,
          await rest(
            `/repos/${path(owner)}/${path(name)}/compare/${path(
              baseOid,
            )}...${path(headOid)}`,
          ),
        );
      } catch (error: unknown) {
        if (
          error instanceof AdapterError &&
          (error.code === "not_found" || error.code === "gone")
        ) {
          throw new AdapterError(
            "invalid_response",
            "GitHub could not compare completion commits",
          );
        }
        throw error;
      }
    },
  };
}

function parseGitHubJson(result: ProcessResult): unknown {
  const response = splitResponse(result.stdout);
  if (result.exitCode !== 0 || response.status >= 400) {
    throw githubFailure(response.status, response.headers, result.stderr);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch (cause: unknown) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned malformed JSON",
      null,
      { cause },
    );
  }
}

function splitResponse(stdout: string): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  if (!stdout.startsWith("HTTP/")) {
    return { status: 0, headers: {}, body: stdout };
  }
  const separator = /\r?\n\r?\n/gu.exec(stdout);
  if (separator === null) {
    return { status: 0, headers: {}, body: "" };
  }
  const head = stdout.slice(0, separator.index);
  const body = stdout.slice(separator.index + separator[0].length);
  const lines = head.split(/\r?\n/gu);
  const statusMatch = /^HTTP\/\S+\s+(\d{3})/u.exec(lines[0] ?? "");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const header = /^([^:]+):\s*(.*)$/u.exec(line);
    if (header === null) continue;
    const name = header[1]?.toLowerCase();
    const value = header[2];
    if (
      name !== undefined &&
      value !== undefined &&
      (name === "retry-after" ||
        name === "x-ratelimit-remaining" ||
        name === "x-ratelimit-reset")
    ) {
      headers[name] = value;
    }
  }
  return {
    status: statusMatch === null ? 0 : Number(statusMatch[1]),
    headers,
    body,
  };
}

function githubFailure(
  parsedStatus: number,
  headers: Readonly<Record<string, string>>,
  stderr: string,
): AdapterError {
  const stderrStatus = /\bHTTP\s+(\d{3})\b/iu.exec(stderr);
  const status =
    parsedStatus > 0 ? parsedStatus : Number(stderrStatus?.[1] ?? Number.NaN);
  const retryAfter = positiveInteger(headers["retry-after"]);
  if (status === 401) {
    return new AdapterError("not_authenticated", "GitHub authentication failed");
  }
  if (status === 403) {
    const rateLimited =
      headers["x-ratelimit-remaining"] === "0" || /rate.?limit/iu.test(stderr);
    return new AdapterError(
      rateLimited ? "rate_limited" : "forbidden",
      rateLimited ? "GitHub rate limit reached" : "GitHub access was forbidden",
      retryAfter,
    );
  }
  if (status === 404) {
    return new AdapterError("not_found", "GitHub resource was not found");
  }
  if (status === 410) {
    return new AdapterError("gone", "GitHub resource is no longer available");
  }
  if (status === 409) {
    return new AdapterError("invalid_response", "GitHub response was inconsistent");
  }
  if (status === 429) {
    return new AdapterError(
      "rate_limited",
      "GitHub rate limit reached",
      retryAfter,
    );
  }
  if (status >= 500) {
    return new AdapterError("network", "GitHub service request failed");
  }
  return new AdapterError("process_failed", "GitHub CLI request failed");
}

function parseDependency(
  raw: z.infer<typeof dependencySchema>,
): DependencySnapshot {
  let url: URL;
  try {
    url = new URL(raw.repository_url);
  } catch (cause: unknown) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned an invalid dependency repository URL",
      null,
      { cause },
    );
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    match === null
  ) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned an invalid dependency repository URL",
    );
  }
  const repositoryOwner = match[1];
  const repositoryName = match[2];
  if (repositoryOwner === undefined || repositoryName === undefined) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned an invalid dependency repository URL",
    );
  }
  return {
    repositoryUrl: raw.repository_url,
    repositoryOwner,
    repositoryName,
    issueNodeId: raw.node_id,
    number: raw.number,
  };
}

function parsePullRequestCloser(input: unknown): PullRequestCloserSnapshot | null {
  const closer = pullRequestCloserSchema.safeParse(input);
  if (closer.success) {
    return {
      nodeId: closer.data.id,
      repositoryNodeId: closer.data.repository.id,
      repositoryOwner: closer.data.repository.owner.login,
      repositoryName: closer.data.repository.name,
      number: closer.data.number,
      url: closer.data.url,
      mergedAt: closer.data.mergedAt,
      mergeCommitOid: closer.data.mergeCommit?.oid ?? null,
      baseBranch: closer.data.baseRefName,
    };
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "__typename" in input &&
    input.__typename === "PullRequest"
  ) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned malformed pull request closure data",
      null,
      { cause: closer.error },
    );
  }
  return null;
}

function parseSchema<Output>(schema: z.ZodType<Output>, input: unknown): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AdapterError(
      "invalid_response",
      "GitHub returned malformed API data",
      null,
      { cause: result.error },
    );
  }
  return result.data;
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function path(value: string): string {
  return encodeURIComponent(value);
}
