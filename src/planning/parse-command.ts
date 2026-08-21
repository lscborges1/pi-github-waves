import { z } from "zod";

import { MAX_SELECTED_NODES } from "../graph/index.js";
import type { PlanDiagnostic } from "./contracts.js";

const issueTokenSchema = z
  .string()
  .regex(/^#?[1-9]\d*$/u)
  .transform((token) => Number(token.replace("#", "")))
  .refine(Number.isSafeInteger);

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

  if (tokens.length < 1 || tokens.length > MAX_SELECTED_NODES) {
    return invalid(`expected 1..${MAX_SELECTED_NODES} issues`);
  }

  const inputOrder: number[] = [];
  const occurrences = new Map<number, number>();
  for (const token of tokens) {
    const result = issueTokenSchema.safeParse(token);
    if (!result.success) {
      return invalid("invalid issue token");
    }
    const issueNumber = result.data;

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
