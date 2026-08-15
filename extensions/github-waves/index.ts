import { createHash } from "node:crypto";

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
import {
  PlanningInvariantError,
  planWaves,
} from "../../src/planning/plan-waves.js";
import {
  formatPlanOutcome,
  renderedPlanSchema,
  type RenderedPlan,
} from "../../src/presentation/format-plan.js";

const ENTRY_TYPE = "waves-plan";
const STATUS_KEY = "github-waves";
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const STACK_FRAME_LOCATION = /(?:^|[\s(/\\])([A-Za-z0-9._-]+:\d+:\d+)\)?$/u;
const MAX_SIGNATURE_FRAMES = 5;

export type WavesPlanEntry = RenderedPlan;
export type GitHubWavesExtensionApi = Pick<
  ExtensionAPI,
  "registerCommand" | "registerEntryRenderer" | "appendEntry"
>;

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

export interface GitHubWavesDependencies {
  readonly createRepository: (
    signal: AbortSignal | undefined,
  ) => RepositoryPort;
  readonly createGitHub: (signal: AbortSignal | undefined) => GitHubReadPort;
  readonly plan: typeof planWaves;
  readonly reportUnexpectedError: (
    error: unknown,
    context: UnexpectedErrorContext,
  ) => void;
}

const DEFAULT_DEPENDENCIES = {
  createRepository: (signal) =>
    createRepositoryPort(signal === undefined ? {} : { signal }),
  createGitHub: (signal) =>
    createGitHubReadPort(signal === undefined ? {} : { signal }),
  plan: planWaves,
  reportUnexpectedError: reportUnexpectedErrorToStderr,
} satisfies GitHubWavesDependencies;

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
            errorSignature: createUnexpectedErrorSignature(error),
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
