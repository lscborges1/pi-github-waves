import { describe, expect, test, vi } from "vitest";
import type {
  CustomEntry,
  EntryRenderer,
  ExtensionCommandContext,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";

import registerGitHubWaves, {
  type GitHubWavesDependencies,
  type GitHubWavesExtensionApi,
  type WavesPlanEntry,
} from "../../extensions/github-waves/index.js";
import type { CommandOutcome } from "../../src/planning/contracts.js";

describe("github-waves extension", () => {
  test("should register the waves command and durable entry renderer", () => {
    const harness = extensionHarness();

    registerGitHubWaves(harness.api, dependencies());

    expect(harness.commands.has("waves")).toBe(true);
    expect(harness.renderers.has("waves-plan")).toBe(true);
  });

  test("should render only the bounded text stored in a durable entry", () => {
    const harness = extensionHarness();
    registerGitHubWaves(harness.api, dependencies());
    const renderer = harness.renderer<WavesPlanEntry>("waves-plan");
    const entry: CustomEntry<WavesPlanEntry> = {
      type: "custom",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType: "waves-plan",
      data: {
        schemaVersion: 1,
        kind: "planned",
        text: "Stored bounded report\nNo execution occurred.",
        truncated: false,
      },
    };
    const theme = {
      bg: (_color: string, text: string) => text,
    } as unknown as Theme;

    const component = renderer(entry, { expanded: false }, theme);

    expect(component?.render(80).join("\n")).toContain("Stored bounded report");
  });

  test("should reject invalid commands before trust or external calls", async () => {
    const plan = vi.fn<GitHubWavesDependencies["plan"]>();
    const harness = extensionHarness();
    registerGitHubWaves(harness.api, dependencies({ plan }));
    const context = commandContext({ trusted: true });

    await harness.command("waves").handler("run #1", context.value);

    expect(plan).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith(
      "expected: /waves plan ISSUE...",
      "error",
    );
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  test("should reject an untrusted project before creating adapters", async () => {
    const createRepository = vi.fn<
      GitHubWavesDependencies["createRepository"]
    >();
    const harness = extensionHarness();
    registerGitHubWaves(
      harness.api,
      dependencies({ createRepository }),
    );
    const context = commandContext({ trusted: false });

    await harness.command("waves").handler("plan #1", context.value);

    expect(createRepository).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith(
      "Project trust is required for /waves plan.",
      "error",
    );
    expect(harness.appendEntry).not.toHaveBeenCalled();
  });

  test("should append one bounded entry and always clear progress", async () => {
    const outcome: CommandOutcome = {
      kind: "fatal",
      code: "rate_limited",
      message: "GitHub rate limit reached",
      retryAfterSeconds: 30,
    };
    const plan = vi.fn<GitHubWavesDependencies["plan"]>(async () => outcome);
    const harness = extensionHarness();
    registerGitHubWaves(harness.api, dependencies({ plan }));
    const context = commandContext({ trusted: true });

    await harness.command("waves").handler("plan #1", context.value);

    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    expect(harness.appendEntry).toHaveBeenCalledWith(
      "waves-plan",
      expect.objectContaining({
        schemaVersion: 1,
        kind: "fatal",
        truncated: false,
        text: expect.stringContaining("No execution occurred."),
      }),
    );
    expect(context.setStatus).toHaveBeenNthCalledWith(
      1,
      "github-waves",
      "Planning GitHub dependency waves…",
    );
    expect(context.setStatus).toHaveBeenLastCalledWith(
      "github-waves",
      undefined,
    );
    expect(context.notify).toHaveBeenCalledWith(
      "Waves plan failed: rate_limited",
      "error",
    );
  });

  test("should persist a stable fatal entry when an unexpected failure occurs", async () => {
    const unexpectedError = new Error("secret adapter detail");
    const plan = vi.fn<GitHubWavesDependencies["plan"]>(async () => {
      throw unexpectedError;
    });
    const reportUnexpectedError = vi.fn();
    const harness = extensionHarness();
    registerGitHubWaves(
      harness.api,
      dependencies({ plan, reportUnexpectedError }),
    );
    const context = commandContext({ trusted: true });

    await harness.command("waves").handler("plan #1", context.value);

    const entry = harness.appendEntry.mock.calls[0]?.[1] as
      | WavesPlanEntry
      | undefined;
    expect(entry?.text).toContain("unexpected planning failure");
    expect(entry?.text).not.toContain("secret adapter detail");
    expect(reportUnexpectedError).toHaveBeenCalledWith(unexpectedError, {
      operation: "waves_plan",
      selectedIssueCount: 1,
    });
    expect(context.setStatus).toHaveBeenLastCalledWith(
      "github-waves",
      undefined,
    );
  });
});

function extensionHarness() {
  const commands = new Map<
    string,
    Omit<RegisteredCommand, "name" | "sourceInfo">
  >();
  const renderers = new Map<string, unknown>();
  const appendEntry = vi.fn();
  const api = {
    registerCommand(
      name: string,
      options: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ): void {
      commands.set(name, options);
    },
    registerEntryRenderer<T = unknown>(
      customType: string,
      renderer: EntryRenderer<T>,
    ): void {
      renderers.set(customType, renderer);
    },
    appendEntry,
  } satisfies GitHubWavesExtensionApi;
  return {
    api,
    commands,
    renderers,
    appendEntry,
    command(name: string) {
      const command = commands.get(name);
      if (command === undefined) throw new Error(`Missing command ${name}`);
      return command;
    },
    renderer<T>(name: string): EntryRenderer<T> {
      const renderer = renderers.get(name);
      if (renderer === undefined) throw new Error(`Missing renderer ${name}`);
      return renderer as EntryRenderer<T>;
    },
  };
}

function commandContext(options: { readonly trusted: boolean }) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const value = {
    cwd: "/worktree",
    signal: undefined,
    isProjectTrusted: () => options.trusted,
    ui: { notify, setStatus },
  } as unknown as ExtensionCommandContext;
  return { value, notify, setStatus };
}

function dependencies(
  overrides: Partial<GitHubWavesDependencies> = {},
): GitHubWavesDependencies {
  return {
    createRepository: vi.fn(() => ({
      discover: vi.fn(async () => {
        throw new Error("unused repository port");
      }),
    })),
    createGitHub: vi.fn(() => ({
      authenticate: vi.fn(async () => undefined),
      getRepository: vi.fn(async () => {
        throw new Error("unused GitHub port");
      }),
      getIssue: vi.fn(async () => {
        throw new Error("unused GitHub port");
      }),
      getBlockedBy: vi.fn(async () => {
        throw new Error("unused GitHub port");
      }),
      getClosureEvents: vi.fn(async () => {
        throw new Error("unused GitHub port");
      }),
      compareCommits: vi.fn(async () => {
        throw new Error("unused GitHub port");
      }),
    })),
    plan: vi.fn(async () => ({
      kind: "cancelled" as const,
      message: "cancelled",
    })),
    reportUnexpectedError: vi.fn(),
    ...overrides,
  };
}
