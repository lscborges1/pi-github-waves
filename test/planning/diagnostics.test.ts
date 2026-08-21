import { describe, expect, test } from "vitest";

import type { PlanDiagnostic } from "../../src/planning/contracts.js";
import { sortPlanDiagnostics } from "../../src/planning/diagnostics.js";

describe("sortPlanDiagnostics", () => {
  test("should sort diagnostics by the complete stable contract", () => {
    const warning = diagnostic({ severity: "warning", issueNumber: 1 });
    const issueTwo = diagnostic({ issueNumber: 2 });
    const codeB = diagnostic({ issueNumber: 1, code: "missing_section" });
    const codeA = diagnostic({ issueNumber: 1, code: "empty_section" });
    const global = diagnostic({ issueNumber: null });

    expect(
      sortPlanDiagnostics([warning, issueTwo, codeB, codeA, global]),
    ).toEqual([global, codeA, codeB, issueTwo, warning]);
  });
});

function diagnostic(
  overrides: Partial<PlanDiagnostic> = {},
): PlanDiagnostic {
  return {
    severity: "error",
    code: "label_missing",
    issueNumber: 1,
    section: null,
    line: null,
    details: {},
    ...overrides,
  };
}
