import type { PlanDiagnostic } from "./contracts.js";

const MAX_ISSUE_ARGUMENTS = 50;
const ISSUE_TOKEN = /^#?([1-9]\d*)$/;

export type ParsePlanCommandOutcome =
  | {
      readonly kind: "valid";
      readonly inputOrder: readonly number[];
      readonly selectedNumbers: readonly number[];
      readonly diagnostics: readonly PlanDiagnostic[];
    }
  | {
      readonly kind: "invalid";
      readonly code: "invalid_command";
      readonly message: string;
    };

export function parsePlanCommand(raw: string): ParsePlanCommandOutcome {
  const tokens = raw.trim() === "" ? [] : raw.trim().split(/\s+/u);
  if (tokens.shift() !== "plan") {
    return invalid("expected: /waves plan ISSUE...");
  }

  if (tokens.length < 1 || tokens.length > MAX_ISSUE_ARGUMENTS) {
    return invalid("expected 1..50 issues");
  }

  const inputOrder: number[] = [];
  const occurrences = new Map<number, number>();
  for (const token of tokens) {
    const match = ISSUE_TOKEN.exec(token);
    const issueNumber = match?.[1] === undefined ? NaN : Number(match[1]);
    if (!Number.isSafeInteger(issueNumber)) {
      return invalid("invalid issue token");
    }

    if (!occurrences.has(issueNumber)) {
      inputOrder.push(issueNumber);
    }
    occurrences.set(issueNumber, (occurrences.get(issueNumber) ?? 0) + 1);
  }

  const selectedNumbers = [...occurrences.keys()].sort((a, b) => a - b);
  const diagnostics = selectedNumbers.flatMap((issueNumber) => {
    const count = occurrences.get(issueNumber) ?? 0;
    return count > 1
      ? [
          {
            severity: "warning",
            code: "duplicate_input",
            issueNumber,
            section: null,
            line: null,
            details: { occurrences: count },
          } satisfies PlanDiagnostic,
        ]
      : [];
  });

  return { kind: "valid", inputOrder, selectedNumbers, diagnostics };
}

function invalid(message: string): ParsePlanCommandOutcome {
  return { kind: "invalid", code: "invalid_command", message };
}
