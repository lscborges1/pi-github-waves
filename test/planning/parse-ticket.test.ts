import { describe, expect, test } from "vitest";

import { parseTicket } from "../../src/planning/parse-ticket.js";

const VALID_TICKET = `## Context
Context text.

## Objective
Objective text.

## Scope
Scope text.

## Out of scope
Out-of-scope text.

## Expected behavior
Expected behavior text.

## Technical notes
Technical notes text.

## Acceptance criteria
- The behavior is observable.

## Test scenarios
- The happy path is covered.
`;

describe("parseTicket", () => {
  test("should accept the complete English ticket contract", () => {
    expect(parseTicket(7, VALID_TICKET)).toEqual({ kind: "valid" });
  });

  test("should accept the complete Portuguese ticket contract", () => {
    const body = VALID_TICKET.replace("Context", "Contexto")
      .replace("Objective", "Objetivo")
      .replace("Scope", "Escopo")
      .replace("Out of scope", "Fora de escopo")
      .replace("Expected behavior", "Comportamento esperado")
      .replace("Technical notes", "Detalhes técnicos")
      .replace("Acceptance criteria", "Critérios de aceite")
      .replace("Test scenarios", "Cenários de teste");

    expect(parseTicket(7, body)).toEqual({ kind: "valid" });
  });

  test("should report a missing section when only a Setext heading exists", () => {
    const body = VALID_TICKET.replace("## Context", "Context\n-------");

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        {
          severity: "error",
          code: "missing_section",
          issueNumber: 7,
          section: "context",
          line: null,
          details: {},
        },
      ]),
    });
  });

  test("should report a duplicate section when both aliases are headings", () => {
    const body = VALID_TICKET.replace(
      "## Objective",
      "## Contexto\nOutro contexto.\n\n## Objective",
    );

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        {
          severity: "error",
          code: "duplicate_section",
          issueNumber: 7,
          section: "context",
          line: 4,
          details: { occurrences: 2 },
        },
      ]),
    });
  });

  test("should report an empty section when it contains only a root comment", () => {
    const body = VALID_TICKET.replace("Context text.", "<!-- hidden -->");

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "empty_section", section: "context" }),
      ]),
    });
  });

  test("should treat a nested HTML comment as section content", () => {
    const body = VALID_TICKET.replace(
      "Context text.",
      "<!-- outer <!-- nested -->",
    );

    expect(parseTicket(7, body)).toEqual({ kind: "valid" });
  });

  test("should stop section content at an unknown heading with closing hashes", () => {
    const body = VALID_TICKET.replace(
      "Context text.",
      "## Notes ###\nContent from an unknown section.",
    );

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "empty_section", section: "context" }),
      ]),
    });
  });

  test("should ignore list items nested inside a block quote", () => {
    const body = VALID_TICKET.replace(
      "- The behavior is observable.",
      "> - Quoted evidence does not count.",
    );

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_list_item",
          section: "acceptanceCriteria",
        }),
      ]),
    });
  });

  test("should reject inline markup in an accepted heading", () => {
    const body = VALID_TICKET.replace("## Objective", "## **Objective**");

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "missing_section", section: "objective" }),
      ]),
    });
  });

  test("should reject a section heading separated by a tab", () => {
    const body = VALID_TICKET.replace("## Context", "##\tContext");

    expect(parseTicket(7, body)).toMatchObject({
      kind: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_section",
          section: "context",
        }),
      ]),
    });
  });

  test("should reject a body larger than 128 KiB by UTF-8 bytes", () => {
    const body = `${VALID_TICKET}${"á".repeat(66_000)}`;

    expect(parseTicket(7, body)).toEqual({
      kind: "invalid",
      diagnostics: [
        {
          severity: "error",
          code: "body_too_large",
          issueNumber: 7,
          section: null,
          line: null,
          details: { actualBytes: Buffer.byteLength(body), maximumBytes: 131_072 },
        },
      ],
    });
  });
});
