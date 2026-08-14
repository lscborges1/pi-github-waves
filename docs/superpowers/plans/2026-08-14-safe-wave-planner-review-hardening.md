# Safe Wave Planner Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five approved review gaps without changing the planner's public command, durable output schema, graph behavior, or dependency footprint.

**Architecture:** Keep validation at the existing GitHub and repository adapter seams, keep closure progress enforcement in the planning application, and keep unexpected-error reporting in the pi extension. Each behavior is introduced through its existing public interface with one focused red-green cycle before the full verification gate.

**Tech Stack:** Node.js 22.19+, TypeScript, Vitest, Zod 4, Node `crypto`, pi 0.84.2, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-14-safe-wave-planner-review-hardening-design.md`

## Global Constraints

- Add no dependency, configuration, graph-contract, command-grammar, durable-entry-schema, GitHub-write, or Git-mutation behavior.
- Keep external JSON validation in `createGitHubReadPort`, repository-origin validation in `parseGitHubOrigin`, closure traversal in `planWaves`, and extension reporting in `extensions/github-waves/index.ts`.
- Parse issue `created_at`, issue `updated_at`, closure-event `createdAt`, and non-null pull-request `mergedAt` as RFC 3339 date-times with `Z` or a numeric UTC offset.
- A continuing closure page must contain an event and advance to a non-null cursor not previously used for that issue.
- An unexpected-error signature is exactly the first 16 lowercase hexadecimal characters of SHA-256 over the canonical safe error name and at most five basename/line/column stack locations.
- Never include error messages, causes, absolute paths, issue data, adapter output, tokens, or PII in the default unexpected-error event.
- Follow one test → one minimal implementation → green per task; do not refactor unrelated code.
- Prefix repository commands with `rtk`; use `rtk proxy` for TypeScript commands so `--noEmit` and other flags are preserved verbatim.

---

### Task 1: Reject mismatched issue snapshots

**Files:**
- Modify: `src/adapters/github-cli.ts:213-234`
- Test: `test/adapters/github-cli.test.ts:59-85`

**Interfaces:**
- Consumes: `GitHubReadPort.getIssue(owner: string, name: string, number: number): Promise<IssueSnapshot>`.
- Produces: the same interface, with `AdapterError("invalid_response", ...)` when the returned issue number differs from `number`.

- [ ] **Step 1: Write the failing public-seam test**

Add beside the existing issue-snapshot test:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts -t "should reject an issue response for a different number"
```

Expected: FAIL because `getIssue(..., 1)` currently resolves with issue number `2`.

- [ ] **Step 3: Add the minimum identity check**

Immediately after parsing `issueSchema` in `getIssue`, add:

```ts
if (issue.number !== number) {
  throw new AdapterError(
    "invalid_response",
    "GitHub returned an unexpected issue number",
  );
}
```

- [ ] **Step 4: Run the adapter test file and verify green**

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts
```

Expected: all GitHub adapter tests PASS.

- [ ] **Step 5: Commit the slice**

```bash
rtk git add src/adapters/github-cli.ts test/adapters/github-cli.test.ts
rtk git commit -m "fix: validate github issue identity"
```

---

### Task 2: Validate every external GitHub timestamp

**Files:**
- Modify: `src/adapters/github-cli.ts:56-131`
- Test: `test/adapters/github-cli.test.ts`

**Interfaces:**
- Consumes: REST issue timestamps and GraphQL closure/closer timestamps parsed from `unknown`.
- Produces: unchanged snapshots containing only RFC 3339 timestamp strings accepted by `z.iso.datetime({ offset: true })`.

- [ ] **Step 1: Add the failing issue timestamp cases**

Add a parameterized test using the complete REST fixture so both fields are exercised through `getIssue`:

```ts
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
```

- [ ] **Step 2: Run the issue cases and verify red**

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts -t "should reject a malformed issue"
```

Expected: both cases FAIL because non-empty strings currently pass.

- [ ] **Step 3: Introduce the shared RFC 3339 schema and make the issue cases green**

Add once near the adapter schemas:

```ts
const timestampSchema = z.iso.datetime({ offset: true });
```

Then replace the issue fields:

```ts
created_at: timestampSchema,
updated_at: timestampSchema,
```

Run:

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts -t "issue.*timestamp|validate and normalize an issue"
```

Expected: the malformed cases and the existing valid `Z` timestamp case PASS.

- [ ] **Step 4: Add failing closure-event timestamp cases**

Use the existing closure response shape and parameterize over both event variants:

```ts
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
```

- [ ] **Step 5: Run the closure-event cases and verify red**

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts -t "should reject malformed.*timestamps"
```

Expected: both closure-event cases FAIL.

- [ ] **Step 6: Apply `timestampSchema` to both closure event variants**

Replace both `createdAt: z.string().min(1)` fields in `closureResponseSchema` with:

```ts
createdAt: timestampSchema,
```

Run the same focused command. Expected: PASS.

- [ ] **Step 7: Add the failing merged timestamp case**

Copy the existing valid pull-request closer response, set only `mergedAt: "invalid"`, and assert:

```ts
await expect(
  port(fixedRunner(jsonResult(response))).getClosureEvents(
    "acme",
    "waves",
    7,
    null,
  ),
).rejects.toMatchObject({ code: "invalid_response" });
```

- [ ] **Step 8: Run the merged timestamp case and verify red**

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts -t "should reject a malformed merged timestamp"
```

Expected: FAIL because `mergedAt` currently accepts any non-empty string.

- [ ] **Step 9: Validate nullable `mergedAt` and run the adapter suite**

Replace the closer field with:

```ts
mergedAt: timestampSchema.nullable(),
```

Run:

```bash
rtk pnpm exec vitest run test/adapters/github-cli.test.ts
```

Expected: all adapter tests PASS, including `Z`, numeric-offset, nullable, and malformed cases.

- [ ] **Step 10: Commit the slice**

```bash
rtk git add src/adapters/github-cli.ts test/adapters/github-cli.test.ts
rtk git commit -m "fix: validate github timestamps"
```

---

### Task 3: Require closure pagination progress

**Files:**
- Modify: `src/planning/plan-waves.ts:335-371`
- Test: `test/planning/plan-waves.test.ts:606-634`

**Interfaces:**
- Consumes: `ClosureEventPage` values from `GitHubReadPort.getClosureEvents`.
- Produces: the existing fatal `CommandOutcome` with code `invalid_response` when a continuing page is empty or reuses any cursor from the same issue traversal.

- [ ] **Step 1: Write the failing repeated-cursor test**

```ts
test("should reject a repeated closure pagination cursor", async () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    kind: "reopened" as const,
    nodeId: `reopen-${index}`,
    createdAt: "2026-01-02T00:00:00Z",
  }));
  const { ports, getClosureEvents } = fakePorts({
    issues: new Map([
      [1, issue({ number: 1, nodeId: "issue-1", state: "CLOSED" })],
    ]),
    closurePage: () => ({
      events,
      hasNextPage: true,
      endCursor: "same-cursor",
    }),
  });

  await expect(planWaves(input([1]), ports)).resolves.toMatchObject({
    kind: "fatal",
    code: "invalid_response",
  });
  expect(getClosureEvents).toHaveBeenCalledTimes(2);
});
```

Expose `getClosureEvents` from `fakePorts` beside its existing returned spies so the assertion remains at the port seam.

- [ ] **Step 2: Run the repeated-cursor test and verify red**

```bash
rtk pnpm exec vitest run test/planning/plan-waves.test.ts -t "should reject a repeated closure pagination cursor"
```

Expected: FAIL by exceeding the fixture's safe call behavior or failing the two-call assertion.

- [ ] **Step 3: Track used cursors and reject reuse**

Initialize state immediately before the closure loop:

```ts
const seenCursors = new Set<string>();
```

Replace the next-cursor block with the minimum checks:

```ts
const nextCursor = page.endCursor;
if (nextCursor === null || seenCursors.has(nextCursor)) {
  throw new AdapterError(
    "invalid_response",
    "closure pagination did not advance",
  );
}
seenCursors.add(nextCursor);
cursor = nextCursor;
```

Run the focused test. Expected: PASS with exactly two calls.

- [ ] **Step 4: Write the failing continuing-empty-page test**

```ts
test("should reject an empty continuing closure page", async () => {
  let page = 0;
  const { ports, getClosureEvents } = fakePorts({
    issues: new Map([
      [1, issue({ number: 1, nodeId: "issue-1", state: "CLOSED" })],
    ]),
    closurePage: () => {
      page += 1;
      return page === 1
        ? { events: [], hasNextPage: true, endCursor: "fresh-cursor" }
        : { events: [], hasNextPage: false, endCursor: null };
    },
  });

  await expect(planWaves(input([1]), ports)).resolves.toMatchObject({
    kind: "fatal",
    code: "invalid_response",
  });
  expect(getClosureEvents).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Run the empty-page test and verify red**

```bash
rtk pnpm exec vitest run test/planning/plan-waves.test.ts -t "should reject an empty continuing closure page"
```

Expected: FAIL because the planner currently requests the next page.

- [ ] **Step 6: Reject empty continuing pages and run the planner suite**

Before accepting `nextCursor`, add:

```ts
if (page.events.length === 0) {
  throw new AdapterError(
    "invalid_response",
    "closure pagination did not advance",
  );
}
```

Run:

```bash
rtk pnpm exec vitest run test/planning/plan-waves.test.ts
```

Expected: all planner tests PASS, including the existing 1,000-event `resource_limit` case.

- [ ] **Step 7: Commit the slice**

```bash
rtk git add src/planning/plan-waves.ts test/planning/plan-waves.test.ts
rtk git commit -m "fix: bound closure pagination"
```

---

### Task 4: Reject explicit GitHub HTTPS ports

**Files:**
- Modify: `src/adapters/git-repository.ts:104-148`
- Test: `test/adapters/git-repository.test.ts:29-43`

**Interfaces:**
- Consumes: `parseGitHubOrigin(originUrl: string)`.
- Produces: the same repository identity for supported origins and `unsupported_repository` for any HTTPS authority containing an explicit port before URL normalization.

- [ ] **Step 1: Add explicit default ports to the rejection table**

Add these inputs to the existing unsupported-origin `test.each` table:

```ts
"https://github.com:443/acme/waves.git",
"https://GITHUB.COM:0443/acme/waves.git",
```

- [ ] **Step 2: Run the focused test and verify red**

```bash
rtk pnpm exec vitest run test/adapters/git-repository.test.ts -t "should reject the unsupported origin"
```

Expected: the two new HTTPS cases FAIL because WHATWG `URL` normalizes the default port to an empty string.

- [ ] **Step 3: Reject a colon in the raw HTTPS authority**

Before `new URL(originUrl)`, add:

```ts
const httpsAuthority = /^https:\/\/([^/]+)/iu.exec(originUrl)?.[1];
if (httpsAuthority?.includes(":") === true) {
  throw unsupported("repository origin URL is unsupported");
}
```

This intentionally runs before URL normalization. Existing credential, scheme, host, query, fragment, path, and SSH-port checks remain unchanged.

- [ ] **Step 4: Run the repository adapter suite and verify green**

```bash
rtk pnpm exec vitest run test/adapters/git-repository.test.ts
```

Expected: all supported and rejected origin cases PASS.

- [ ] **Step 5: Commit the slice**

```bash
rtk git add src/adapters/git-repository.ts test/adapters/git-repository.test.ts
rtk git commit -m "fix: reject explicit github origin ports"
```

---

### Task 5: Add safely grouped unexpected-error reporting

**Files:**
- Modify: `extensions/github-waves/index.ts:1-152`
- Test: `test/extension/github-waves.test.ts:148-244`

**Interfaces:**
- Produces: `createUnexpectedErrorSignature(error: unknown): string`.
- Produces: `reportUnexpectedErrorToStderr(error: unknown, context: UnexpectedErrorContext): void`.
- Extends: `GitHubWavesDependencies.reportUnexpectedError` context with `readonly errorSignature: string`.
- Preserves: durable entry payload and user-facing outcome text.

- [ ] **Step 1: Write the failing golden and normalization tests**

Import the new named exports from the extension module and add:

```ts
test("should create a stable redacted unexpected-error signature", () => {
  const first = new Error("first secret");
  first.stack = [
    "Error: first secret",
    "    at plan (/Users/alice/private/index.js:42:7)",
    "    at run (/Users/alice/private/runner.js:9:2)",
  ].join("\n");
  const second = new Error("second secret");
  second.stack = [
    "Error: second secret",
    "    at plan (/srv/build/index.js:42:7)",
    "    at run (/srv/build/runner.js:9:2)",
  ].join("\n");

  expect(createUnexpectedErrorSignature(first)).toBe("6195152eb6f821be");
  expect(createUnexpectedErrorSignature(second)).toBe("6195152eb6f821be");
});

test("should use a stable fallback when an unexpected value has no stack", () => {
  expect(createUnexpectedErrorSignature("secret thrown value")).toBe(
    createUnexpectedErrorSignature({ secret: "different" }),
  );
  expect(createUnexpectedErrorSignature("secret thrown value")).toMatch(
    /^[a-f0-9]{16}$/u,
  );
});
```

- [ ] **Step 2: Run the signature tests and verify red**

```bash
rtk pnpm exec vitest run test/extension/github-waves.test.ts -t "unexpected-error signature|unexpected value has no stack"
```

Expected: FAIL because the named signature export does not exist.

- [ ] **Step 3: Implement the canonical signature algorithm**

Add imports and constants:

```ts
import { createHash } from "node:crypto";

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const STACK_FRAME_LOCATION = /([A-Za-z0-9._-]+:\d+:\d+)\)?$/u;
const MAX_SIGNATURE_FRAMES = 5;
```

Add the pure helper:

```ts
export function createUnexpectedErrorSignature(error: unknown): string {
  const errorName =
    error instanceof Error && SAFE_ERROR_NAME.test(error.name)
      ? error.name
      : "UnknownError";
  const frames =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split(/\r?\n/u)
          .slice(1)
          .flatMap((line) => {
            const location = STACK_FRAME_LOCATION.exec(line.trim())?.[1];
            return location === undefined ? [] : [location];
          })
          .slice(0, MAX_SIGNATURE_FRAMES)
      : [];
  const canonical = [
    errorName,
    ...(frames.length === 0 ? ["no-stack"] : frames),
  ].join("|");

  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 16);
}
```

Run the focused signature tests. Expected: PASS with the golden value.

- [ ] **Step 4: Write the failing default stderr test**

Define and export the reporting context type, then add this test against the named reporter:

```ts
test("should write only safe unexpected-error metadata to stderr", () => {
  const error = new Error("secret adapter detail");
  error.stack = [
    "Error: secret adapter detail",
    "    at plan (/Users/alice/private/index.js:42:7)",
  ].join("\n");
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  try {
    reportUnexpectedErrorToStderr(error, {
      operation: "waves_plan",
      selectedIssueCount: 1,
      errorSignature: createUnexpectedErrorSignature(error),
    });

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain('"errorSignature":"672c78c41d329a14"');
    expect(output).not.toContain("secret adapter detail");
    expect(output).not.toContain("/Users/alice/private");
  } finally {
    write.mockRestore();
  }
});
```

- [ ] **Step 5: Run the stderr test and verify red**

```bash
rtk pnpm exec vitest run test/extension/github-waves.test.ts -t "should write only safe unexpected-error metadata to stderr"
```

Expected: FAIL because the named reporter does not exist.

- [ ] **Step 6: Extract the production stderr reporter**

Define:

```ts
export interface UnexpectedErrorContext {
  readonly operation: "waves_plan";
  readonly selectedIssueCount: number;
  readonly errorSignature: string;
}

export function reportUnexpectedErrorToStderr(
  error: unknown,
  context: UnexpectedErrorContext,
): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "github_waves_unexpected_error",
      ...context,
      errorName:
        error instanceof Error && SAFE_ERROR_NAME.test(error.name)
          ? error.name
          : "UnknownError",
      ...(error instanceof PlanningInvariantError
        ? { graphErrors: error.graphErrors }
        : {}),
    })}\n`,
  );
}
```

Change `GitHubWavesDependencies.reportUnexpectedError` to consume `UnexpectedErrorContext`, and set the default dependency with `reportUnexpectedError: reportUnexpectedErrorToStderr` using `satisfies GitHubWavesDependencies`.

Run the stderr test. Expected: PASS.

- [ ] **Step 7: Make the command pass the signature through the injected seam**

First update the existing unexpected-failure test expectation:

```ts
expect(reportUnexpectedError).toHaveBeenCalledWith(unexpectedError, {
  operation: "waves_plan",
  selectedIssueCount: 1,
  errorSignature: expect.stringMatching(/^[a-f0-9]{16}$/u),
});
```

Run that single test and verify it fails because the context lacks `errorSignature`. Then change the catch block to:

```ts
dependencies.reportUnexpectedError(error, {
  operation: "waves_plan",
  selectedIssueCount: parsed.selectedNumbers.length,
  errorSignature: createUnexpectedErrorSignature(error),
});
```

Retain the assertions that the durable entry contains `unexpected planning failure` and excludes the underlying secret message.

- [ ] **Step 8: Run the extension suite and verify green**

```bash
rtk pnpm exec vitest run test/extension/github-waves.test.ts
```

Expected: all extension tests PASS.

- [ ] **Step 9: Commit the slice**

```bash
rtk git add extensions/github-waves/index.ts test/extension/github-waves.test.ts
rtk git commit -m "fix: improve planner error reporting"
```

---

### Task 6: Verify the complete package

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all five committed slices.
- Produces: evidence that tests, types, build output, package contents, pi loading, diff hygiene, and workspace cleanliness satisfy the approved spec.

- [ ] **Step 1: Run all tests**

```bash
rtk pnpm test
```

Expected: all test files and tests PASS.

- [ ] **Step 2: Run typecheck without emitting beside source**

```bash
rtk proxy pnpm typecheck
```

Expected: exit code 0 and no new `.js` files under `src/`, `test/`, or `extensions/`.

- [ ] **Step 3: Build and inspect package contents**

```bash
rtk proxy pnpm build
rtk proxy pnpm pack --dry-run
```

Expected: both commands exit 0; the tarball includes `dist/extensions/github-waves/index.js`, compiled planner/adapter modules, README, LICENSE, and `skills/github-waves`.

- [ ] **Step 4: Smoke-load the pi package without persistence**

```bash
rtk proxy pnpm exec pi -e . --offline --no-session --mode rpc < /dev/null
```

Expected: exit code 0 with no extension-load diagnostic.

- [ ] **Step 5: Check the full branch diff and clean state**

```bash
rtk git diff --check origin/main...HEAD
rtk git status --short
```

Expected: `git diff --check` exits 0 and `git status --short` is empty. If a wrapper emitted untracked compiled files beside source, remove only the exact newly generated untracked files after confirming they were absent before verification, then rerun status.

- [ ] **Step 6: Review final scope**

Confirm the branch contains only the approved design/plan plus the five implementation slices, no dependency changes, and no modifications to graph contracts, command grammar, or durable entry schema.
