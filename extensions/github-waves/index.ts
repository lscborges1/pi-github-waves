import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createRepositoryPort } from "../../src/adapters/git-repository.js";
import { createGitHubReadPort } from "../../src/adapters/github-cli.js";
import type {
  CommandOutcome,
  GitHubReadPort,
  RepositoryPort,
} from "../../src/planning/contracts.js";
import { parsePlanCommand } from "../../src/planning/parse-command.js";
import { planWaves } from "../../src/planning/plan-waves.js";
import {
  formatPlanOutcome,
  renderedPlanSchema,
  type RenderedPlan,
} from "../../src/presentation/format-plan.js";

const ENTRY_TYPE = "waves-plan";
const STATUS_KEY = "github-waves";

export type WavesPlanEntry = RenderedPlan;
export type GitHubWavesExtensionApi = Pick<
  ExtensionAPI,
  "registerCommand" | "registerEntryRenderer" | "appendEntry"
>;

export interface GitHubWavesDependencies {
  readonly createRepository: (
    signal: AbortSignal | undefined,
  ) => RepositoryPort;
  readonly createGitHub: (signal: AbortSignal | undefined) => GitHubReadPort;
  readonly plan: typeof planWaves;
  readonly reportUnexpectedError: (
    error: unknown,
    context: {
      readonly operation: "waves_plan";
      readonly selectedIssueCount: number;
    },
  ) => void;
}

const DEFAULT_DEPENDENCIES: GitHubWavesDependencies = {
  createRepository: (signal) =>
    createRepositoryPort(signal === undefined ? {} : { signal }),
  createGitHub: (signal) =>
    createGitHubReadPort(signal === undefined ? {} : { signal }),
  plan: planWaves,
  reportUnexpectedError: (error, context) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "github_waves_unexpected_error",
        ...context,
        errorName: error instanceof Error ? error.name : "UnknownThrownValue",
      })}\n`,
    );
  },
};

export default function registerGitHubWaves(
  pi: GitHubWavesExtensionApi,
  dependencies: GitHubWavesDependencies = DEFAULT_DEPENDENCIES,
): void {
  pi.registerEntryRenderer<WavesPlanEntry>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const parsed = renderedPlanSchema.safeParse(entry.data);
      const text = parsed.success
        ? parsed.data.text
        : "Invalid waves-plan session entry.";
      return new Text(text, 1, 0, (line) =>
        theme.bg("customMessageBg", line),
      );
    },
  );

  pi.registerCommand("waves", {
    description: "Plan read-only GitHub dependency waves",
    handler: async (args, context) => {
      const parsed = parsePlanCommand(args);
      if (parsed.kind === "invalid") {
        context.ui.notify(parsed.message, "error");
        return;
      }
      if (!context.isProjectTrusted()) {
        context.ui.notify(
          "Project trust is required for /waves plan.",
          "error",
        );
        return;
      }

      context.ui.setStatus(
        STATUS_KEY,
        "Planning GitHub dependency waves…",
      );
      try {
        let outcome: CommandOutcome;
        try {
          outcome = await dependencies.plan(
            {
              cwd: context.cwd,
              selection: {
                inputOrder: parsed.inputOrder,
                selectedNumbers: parsed.selectedNumbers,
                diagnostics: parsed.diagnostics,
              },
            },
            {
              repository: dependencies.createRepository(context.signal),
              github: dependencies.createGitHub(context.signal),
            },
          );
        } catch (error: unknown) {
          dependencies.reportUnexpectedError(error, {
            operation: "waves_plan",
            selectedIssueCount: parsed.selectedNumbers.length,
          });
          outcome = {
            kind: "fatal",
            code: "invalid_response",
            message: "unexpected planning failure",
            retryAfterSeconds: null,
          };
        }

        const entry = formatPlanOutcome(outcome);
        pi.appendEntry<WavesPlanEntry>(ENTRY_TYPE, entry);
        notifyOutcome(outcome, context.ui.notify);
      } finally {
        context.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}

function notifyOutcome(
  outcome: CommandOutcome,
  notify: (message: string, type?: "info" | "warning" | "error") => void,
): void {
  if (outcome.kind === "fatal") {
    notify(`Waves plan failed: ${outcome.code}`, "error");
  } else if (outcome.kind === "cancelled") {
    notify("Waves plan cancelled.", "warning");
  }
}
