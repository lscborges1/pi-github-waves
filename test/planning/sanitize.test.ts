import { describe, expect, test } from "vitest";

import { sanitizeInlineText } from "../../src/planning/sanitize.js";

describe("sanitizeInlineText", () => {
  test("should remove terminal escapes and flatten control characters", () => {
    expect(
      sanitizeInlineText("\u001b[31mDanger\u001b[0m\r\nnext\u0000value\u007f"),
    ).toBe("Danger next value");
  });

  test("should preserve printable Unicode text", () => {
    expect(sanitizeInlineText("  Critérios — ação  ")).toBe(
      "Critérios — ação",
    );
  });
});
