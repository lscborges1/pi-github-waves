# Safe Wave Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, read-only `/waves plan` command that translates live GitHub Issues into the existing dependency-wave graph and a bounded pi TUI report.

**Architecture:** Pure planning modules depend on small repository and GitHub read ports. CLI adapters validate untrusted output at the boundary; the pi extension only handles trust, progress, and presentation. The graph core remains unchanged.

**Tech Stack:** Node.js 22.19+, TypeScript, Vitest, fast-check, Zod, mdast-util-from-markdown, pi 0.84.x, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-14-safe-wave-planner-design.md`

## Global Constraints

- Preserve the `./graph` public export and do not change graph contracts or behavior.
- Use pnpm, strict TypeScript, no `any`, Zod at external boundaries, and executable-plus-argv subprocess calls.
- Follow red-green-refactor for every behavioral change.
- Support GitHub.com only; GitHub Issues and native dependencies are authoritative.
- Perform no fetch, GitHub write, branch/worktree/commit mutation, worker execution, config loading, fingerprinting, or run persistence.
- Use conventional commits without assistant/tool names.

---

### Task 1: Align source-of-truth documentation

**Files:**
- Create: `CONTEXT.md`
- Create: `docs/superpowers/specs/2026-08-14-safe-wave-planner-design.md`
- Create: `docs/superpowers/plans/2026-08-14-safe-wave-planner.md`
- Modify externally: GitHub Issue #4

- [ ] Update Issue #4 to the approved native-only, zero-fetch, no-config, no-fingerprint scope.
- [ ] Run the spec-document-reviewer loop and fix blocking findings.
- [ ] Verify links, headings, and absence of placeholders.
- [ ] Commit with `docs: design safe wave planner`.

### Task 2: Package surface and pure parsers

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`
- Create: `src/planning/contracts.ts`, `src/planning/parse-command.ts`, `src/planning/parse-ticket.ts`
- Test: `test/planning/parse-command.test.ts`, `test/planning/parse-ticket.test.ts`

**Interfaces:**
- Produces `parsePlanCommand(raw: string): ParsePlanCommandOutcome`.
- Produces `parseTicket(body: string): TicketParseOutcome`.
- Defines versioned snapshots, diagnostics, ports, `PlanResultV1`, and `CommandOutcome`.

- [ ] Write command-parser contract tests; run them and confirm missing-module failure.
- [ ] Implement the minimal exact grammar and stable duplicate warnings; rerun to green.
- [ ] Write ticket-parser tests for the valid bilingual contract, then every required failure family; confirm red.
- [ ] Implement CommonMark parsing, size limits, heading sections, comment-aware emptiness, and list evidence; rerun to green.
- [ ] Add current pi metadata, runtime/peer dependencies, package files, Node engine, and extension-aware typecheck configuration.
- [ ] Run parser tests, full tests, typecheck, and build.
- [ ] Commit with `feat: parse safe wave plans`.

### Task 3: Planning application and completion semantics

**Files:**
- Create: `src/planning/plan-waves.ts`, `src/planning/diagnostics.ts`, `src/planning/sanitize.ts`
- Test: `test/planning/plan-waves.test.ts`, `test/planning/sanitize.test.ts`

**Interfaces:**
- Consumes `RepositoryPort`, `GitHubReadPort`, parsed selection, and `buildDependencyWaveGraph`.
- Produces `planWaves(selection, ports): Promise<CommandOutcome>`.

- [ ] Write fake-port tests for deterministic breadth-first loading, selection/boundary roles, and response-order invariance; confirm red.
- [ ] Implement traversal with atomic exported boundary/edge limits and completion barriers; rerun to green.
- [ ] Write completion tests for merged, squash/rebase, multiple closers, wrong base, manual close, missing OID, and unreachable commits; confirm red.
- [ ] Add reopen/reclose epoch, 1,000-event pagination, and completion evidence tests; implement compare-result interpretation; rerun to green.
- [ ] Write eligibility, missing/inaccessible issue, label, ticket, cycle, external blocker, and no-partial-plan tests; confirm red.
- [ ] Implement graph translation, stable diagnostics, and `PlanResultV1`; rerun to green.
- [ ] Run planning tests, full tests, typecheck, and build.
- [ ] Commit with `feat: plan github dependency waves`.

### Task 4: Read-only Git and GitHub adapters

**Files:**
- Create: `src/adapters/run-process.ts`, `src/adapters/git-repository.ts`, `src/adapters/github-cli.ts`
- Test: `test/adapters/run-process.test.ts`, `test/adapters/git-repository.test.ts`, `test/adapters/github-cli.test.ts`
- Fixtures: `test/fixtures/bin/`, `test/fixtures/github/`

**Interfaces:**
- Implements `RepositoryPort.discover(cwd)` and `GitHubReadPort` with typed `AdapterError` failures.

- [ ] Write subprocess tests for separate stdout/stderr, byte caps, timeout/abort cleanup, and sanitized error context; confirm red.
- [ ] Implement `spawn`-based execution without shell interpolation; rerun to green.
- [ ] Write repository discovery/remote parsing tests for supported URLs and every rejection; confirm red.
- [ ] Implement read-only Git discovery; rerun to green.
- [ ] Write GitHub fixture tests for auth, repository/tip, issue, paginated native dependencies, paginated closure epochs, comparisons, HTTP classes, and malformed Zod inputs; confirm red.
- [ ] Implement the minimum `gh api` adapter using API version `2026-03-10`; immediately discard non-whitelisted headers and raw bodies after parsing.
- [ ] Assert recorded argv contains no mutating Git command, HTTP method, or endpoint.
- [ ] Run adapter tests, full tests, typecheck, and build.
- [ ] Commit with `feat: read github planning data`.

### Task 5: Pi extension, renderer, and operating skill

**Files:**
- Create: `src/presentation/format-plan.ts`, `extensions/github-waves/index.ts`, `skills/github-waves/SKILL.md`
- Test: `test/presentation/format-plan.test.ts`, `test/extension/github-waves.test.ts`

**Interfaces:**
- Produces `formatPlanOutcome(outcome, limits): RenderedPlan`.
- Registers `/waves plan`, a `waves-plan` entry renderer, and no tools or write commands.

- [ ] Write renderer tests for successful/non-runnable/fatal plans, sanitization, deterministic text, 50 KiB and 2,000-line caps; confirm red.
- [ ] Implement the minimal formatter; rerun to green.
- [ ] Write extension tests for registration, trust rejection before external calls, status cleanup, one durable entry, and fatal notification; confirm red.
- [ ] Implement the extension factory and textual entry renderer using current pi interfaces; rerun to green.
- [ ] Write the bundled skill with prerequisites, exact ticket contract, native dependencies, command usage, and read-only guarantees.
- [ ] Run presentation/extension tests, full tests, typecheck, and build.
- [ ] Commit with `feat: expose waves plan command`.

### Task 6: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] Update capability status, installation, `/waves plan` usage, ticket contract, native dependency setup, safety, and UI/macOS roadmap.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm pack --dry-run` from the final tree.
- [ ] Run a temporary `pi -e .` package-load smoke test without persistent installation.
- [ ] Inspect `git diff origin/main...HEAD`, package contents, and `git status --short`.
- [ ] Commit with `docs: document safe wave planner`.
