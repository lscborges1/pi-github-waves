import { z } from "zod";

import type {
  CommandOutcome,
  CompletionEvidence,
  PlanDiagnostic,
  PlanResultV1,
} from "../planning/contracts.js";
import { compareOpaqueId } from "../graph/compare.js";
import { sanitizeInlineText } from "../planning/sanitize.js";

const DEFAULT_MAXIMUM_BYTES = 50 * 1024;
const DEFAULT_MAXIMUM_LINES = 2_000;
const SAFETY_FOOTER = "No execution occurred.";

export interface RenderLimits {
  readonly maximumBytes: number;
  readonly maximumLines: number;
}

export const renderedPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(["planned", "fatal", "cancelled"]),
    text: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export type RenderedPlan = Readonly<z.infer<typeof renderedPlanSchema>>;

export function formatPlanOutcome(
  outcome: CommandOutcome,
  limits: RenderLimits = {
    maximumBytes: DEFAULT_MAXIMUM_BYTES,
    maximumLines: DEFAULT_MAXIMUM_LINES,
  },
): RenderedPlan {
  const lines =
    outcome.kind === "planned"
      ? plannedLines(outcome.plan)
      : outcome.kind === "fatal"
        ? fatalLines(outcome)
        : [
            `Waves plan cancelled: ${sanitizeInlineText(outcome.message)}`,
            "",
            SAFETY_FOOTER,
          ];
  const bounded = boundLines(lines, limits);
  return {
    schemaVersion: 1,
    kind: outcome.kind,
    text: bounded.text,
    truncated: bounded.truncated,
  };
}

function plannedLines(plan: PlanResultV1): readonly string[] {
  const lines: string[] = [
    "Waves plan",
    `Repository: ${inline(plan.repository.owner)}/${inline(plan.repository.name)}`,
    `Default branch: ${inline(plan.repository.defaultBranch)} @ ${inline(
      plan.repository.defaultBranchTipOid,
    )}`,
    `Input order: ${plan.inputOrder.map((number) => `#${number}`).join(" ")}`,
    `Runnable: ${plan.runnable ? "yes" : "no"}`,
    "",
    "Selected issues:",
  ];
  if (plan.selected.length === 0) lines.push("- none");
  for (const issue of plan.selected) {
    lines.push(
      `- #${issue.number} [${issue.graphNode?.disposition ?? "unavailable"}] ${inline(
        issue.title ?? "unavailable",
      )}${issue.url === null ? "" : ` (${inline(issue.url)})`}`,
    );
    lines.push(...completionLines(issue.completion));
  }

  lines.push("", "Boundary issues:");
  if (plan.boundary.length === 0) lines.push("- none");
  for (const issue of plan.boundary) {
    const state = issue.completion.completed
      ? "complete"
      : (issue.graphNode?.status ?? "unavailable");
    lines.push(
      `- #${issue.number} [${state}] ${inline(issue.title ?? "unavailable")}${
        issue.url === null ? "" : ` (${inline(issue.url)})`
      }`,
    );
    lines.push(...completionLines(issue.completion));
  }

  lines.push("", "Native dependency edges:");
  if (plan.edges.length === 0) lines.push("- none");
  for (const edge of plan.edges) {
    lines.push(`- #${edge.blockerNumber} blocks #${edge.blockedNumber}`);
  }

  lines.push("", "Cycles:");
  if ((plan.graph?.cycles.length ?? 0) === 0) lines.push("- none");
  for (const cycle of plan.graph?.cycles ?? []) {
    lines.push(
      `- ${cycle.issueNumbers.map((number) => `#${number}`).join(" -> ")}`,
    );
  }

  lines.push("", "Waves:");
  if ((plan.graph?.levels.length ?? 0) === 0) lines.push("- none");
  for (const level of plan.graph?.levels ?? []) {
    lines.push(
      `- Level ${level.level}: ${level.batches
        .map(
          (batch) =>
            `[${batch.map((number) => `#${number}`).join(", ")}]`,
        )
        .join(" | ")}`,
    );
  }

  lines.push("", "Diagnostics:");
  if (plan.diagnostics.length === 0) lines.push("- none");
  for (const diagnostic of plan.diagnostics) {
    lines.push(formatDiagnostic(diagnostic));
  }
  lines.push("", SAFETY_FOOTER);
  return lines;
}

function fatalLines(
  outcome: Extract<CommandOutcome, { kind: "fatal" }>,
): readonly string[] {
  return [
    `Waves plan failed [${outcome.code}]: ${inline(outcome.message)}`,
    "",
    SAFETY_FOOTER,
  ];
}

function completionLines(completion: CompletionEvidence): readonly string[] {
  return completion.pullRequests.map(
    (pullRequest) =>
      `  completion: PR #${pullRequest.number} @ ${inline(
        pullRequest.mergeCommitOid,
      )} (${pullRequest.reachable ? "reachable" : "unreachable"})`,
  );
}

function formatDiagnostic(diagnostic: PlanDiagnostic): string {
  const issue =
    diagnostic.issueNumber === null ? "" : ` issue=#${diagnostic.issueNumber}`;
  const section =
    diagnostic.section === null ? "" : ` section=${diagnostic.section}`;
  const line = diagnostic.line === null ? "" : ` line=${diagnostic.line}`;
  const details = Object.keys(diagnostic.details)
    .sort(compareOpaqueId)
    .map((key) => `${inline(key)}=${inline(String(diagnostic.details[key]))}`)
    .join(" ");
  return `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${issue}${section}${line}${
    details.length === 0 ? "" : ` ${details}`
  }`;
}

function boundLines(
  lines: readonly string[],
  limits: RenderLimits,
): { readonly text: string; readonly truncated: boolean } {
  const maximumBytes = Math.max(1, Math.floor(limits.maximumBytes));
  const maximumLines = Math.max(1, Math.floor(limits.maximumLines));
  const completeText = lines.join("\n");
  if (
    lines.length <= maximumLines &&
    Buffer.byteLength(completeText, "utf8") <= maximumBytes
  ) {
    return { text: completeText, truncated: false };
  }

  const included: string[] = [];
  const contentLines =
    lines.at(-1) === SAFETY_FOOTER ? lines.slice(0, -1) : lines;
  if (maximumLines === 1) {
    return {
      text: truncateUtf8(SAFETY_FOOTER, maximumBytes),
      truncated: true,
    };
  }
  const contentLineLimit = Math.max(0, maximumLines - 2);
  for (const line of contentLines) {
    if (included.length >= contentLineLimit) break;
    const nextCount = included.length + 1;
    const marker = omissionMarker(contentLines.length - nextCount);
    const candidate = [...included, line, marker, SAFETY_FOOTER].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > maximumBytes) break;
    included.push(line);
  }
  const marker = omissionMarker(contentLines.length - included.length);
  const text = [...included, marker, SAFETY_FOOTER].join("\n");
  return {
    text:
      Buffer.byteLength(text, "utf8") <= maximumBytes
        ? text
        : truncateUtf8(SAFETY_FOOTER, maximumBytes),
    truncated: true,
  };
}

function omissionMarker(omittedLines: number): string {
  return `[Output truncated: ${omittedLines} lines omitted.]`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximumBytes) break;
    result += character;
  }
  return result;
}

function inline(value: string): string {
  return sanitizeInlineText(value);
}
