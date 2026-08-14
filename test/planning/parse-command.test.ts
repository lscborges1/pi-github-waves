import { describe, expect, test } from "vitest";

import { parsePlanCommand } from "../../src/planning/parse-command.js";

describe("parsePlanCommand", () => {
  test("should canonicalize valid issue arguments when plan is requested", () => {
    const outcome = parsePlanCommand("plan #7 3 #7 12");

    expect(outcome).toEqual({
      kind: "valid",
      inputOrder: [7, 3, 12],
      selectedNumbers: [3, 7, 12],
      diagnostics: [
        {
          severity: "warning",
          code: "duplicate_input",
          issueNumber: 7,
          section: null,
          line: null,
          details: { occurrences: 2 },
        },
      ],
    });
  });

  test.each([
    ["", "expected: /waves plan ISSUE..."],
    ["status #3", "expected: /waves plan ISSUE..."],
    ["plan", "expected 1..50 issues"],
    ["plan #03", "invalid issue token"],
    ["plan owner/repo#3", "invalid issue token"],
    ["plan 9007199254740992", "invalid issue token"],
  ])(
    "should reject an invalid command when input is %j",
    (raw, expectedMessage) => {
      expect(parsePlanCommand(raw)).toEqual({
        kind: "invalid",
        code: "invalid_command",
        message: expectedMessage,
      });
    },
  );

  test("should reject more than fifty arguments before deduplication", () => {
    const issues = Array.from({ length: 51 }, () => "#1").join(" ");

    expect(parsePlanCommand(`plan ${issues}`)).toEqual({
      kind: "invalid",
      code: "invalid_command",
      message: "expected 1..50 issues",
    });
  });
});
