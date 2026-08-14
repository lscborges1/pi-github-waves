import { fromMarkdown } from "mdast-util-from-markdown";

import type {
  PlanDiagnostic,
  TicketSection,
} from "./contracts.js";

const MAX_ISSUE_BODY_BYTES = 128 * 1024;
const ATX_LEVEL_TWO = /^ {0,3}##[\t ]+(.*)$/u;
const CLOSING_HASHES = /[\t ]+#+[\t ]*$/u;
const COMPLETE_HTML_COMMENT = /^<!--[\s\S]*-->$/u;

const SECTION_ORDER = [
  "context",
  "objective",
  "scope",
  "outOfScope",
  "expectedBehavior",
  "technicalNotes",
  "acceptanceCriteria",
  "testScenarios",
] as const satisfies readonly TicketSection[];

const HEADING_ALIASES = new Map<string, TicketSection>([
  ["context", "context"],
  ["contexto", "context"],
  ["objective", "objective"],
  ["objetivo", "objective"],
  ["scope", "scope"],
  ["escopo", "scope"],
  ["out of scope", "outOfScope"],
  ["fora de escopo", "outOfScope"],
  ["expected behavior", "expectedBehavior"],
  ["comportamento esperado", "expectedBehavior"],
  ["technical notes", "technicalNotes"],
  ["detalhes técnicos", "technicalNotes"],
  ["acceptance criteria", "acceptanceCriteria"],
  ["critérios de aceite", "acceptanceCriteria"],
  ["test scenarios", "testScenarios"],
  ["cenários de teste", "testScenarios"],
]);

type RootNode = ReturnType<typeof fromMarkdown>["children"][number];
type HeadingNode = Extract<RootNode, { readonly type: "heading" }>;
type HeadingChild = HeadingNode["children"][number];
type TextNode = Extract<HeadingChild, { readonly type: "text" }>;

interface SectionOccurrence {
  readonly rootIndex: number;
  readonly line: number;
}

export type TicketParseOutcome =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly PlanDiagnostic[];
    };

export function parseTicket(
  issueNumber: number,
  body: string,
): TicketParseOutcome {
  const actualBytes = Buffer.byteLength(body, "utf8");
  if (actualBytes > MAX_ISSUE_BODY_BYTES) {
    return {
      kind: "invalid",
      diagnostics: [
        diagnostic(issueNumber, "body_too_large", null, null, {
          actualBytes,
          maximumBytes: MAX_ISSUE_BODY_BYTES,
        }),
      ],
    };
  }

  const root = fromMarkdown(body);
  const lines = body.split(/\r?\n/u);
  const boundaries = new Set<number>();
  const occurrences = new Map<TicketSection, SectionOccurrence[]>();

  for (const [rootIndex, node] of root.children.entries()) {
    if (!isAtxLevelTwo(node, lines)) {
      continue;
    }
    boundaries.add(rootIndex);

    if (!node.children.every(isTextNode)) {
      continue;
    }
    const heading = asciiLowercase(
      node.children.map((child) => child.value).join("").trim(),
    );
    const section = HEADING_ALIASES.get(heading);
    if (section === undefined) {
      continue;
    }

    const line = node.position?.start.line ?? 1;
    const sectionOccurrences = occurrences.get(section) ?? [];
    sectionOccurrences.push({ rootIndex, line });
    occurrences.set(section, sectionOccurrences);
  }

  const diagnostics: PlanDiagnostic[] = [];
  for (const section of SECTION_ORDER) {
    const sectionOccurrences = occurrences.get(section) ?? [];
    if (sectionOccurrences.length === 0) {
      diagnostics.push(
        diagnostic(issueNumber, "missing_section", section, null, {}),
      );
      continue;
    }

    if (sectionOccurrences.length > 1) {
      diagnostics.push(
        diagnostic(
          issueNumber,
          "duplicate_section",
          section,
          sectionOccurrences[1]?.line ?? null,
          { occurrences: sectionOccurrences.length },
        ),
      );
    }

    const first = sectionOccurrences[0];
    if (first === undefined) {
      continue;
    }
    const content = sectionContent(root.children, boundaries, first.rootIndex);
    if (!hasNonCommentContent(content, body)) {
      diagnostics.push(
        diagnostic(issueNumber, "empty_section", section, first.line, {}),
      );
    }

    if (
      (section === "acceptanceCriteria" || section === "testScenarios") &&
      !hasRootListItem(content)
    ) {
      diagnostics.push(
        diagnostic(issueNumber, "missing_list_item", section, first.line, {}),
      );
    }
  }

  return diagnostics.length === 0
    ? { kind: "valid" }
    : { kind: "invalid", diagnostics };
}

function isTextNode(node: HeadingChild): node is TextNode {
  return node.type === "text";
}

function isAtxLevelTwo(
  node: RootNode,
  lines: readonly string[],
): node is HeadingNode {
  if (node.type !== "heading" || node.depth !== 2) {
    return false;
  }
  const line = lines[(node.position?.start.line ?? 1) - 1] ?? "";
  const match = ATX_LEVEL_TWO.exec(line);
  return match !== null && !CLOSING_HASHES.test(match[1] ?? "");
}

function sectionContent(
  nodes: readonly RootNode[],
  boundaries: ReadonlySet<number>,
  headingIndex: number,
): readonly RootNode[] {
  let end = nodes.length;
  for (let index = headingIndex + 1; index < nodes.length; index += 1) {
    if (boundaries.has(index)) {
      end = index;
      break;
    }
  }
  return nodes.slice(headingIndex + 1, end);
}

function hasNonCommentContent(
  nodes: readonly RootNode[],
  source: string,
): boolean {
  return nodes.some((node) => {
    if (
      node.type === "html" &&
      COMPLETE_HTML_COMMENT.test(node.value.trim())
    ) {
      return false;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return (
      typeof start === "number" &&
      typeof end === "number" &&
      source.slice(start, end).trim() !== ""
    );
  });
}

function hasRootListItem(nodes: readonly RootNode[]): boolean {
  return nodes.some(
    (node) => node.type === "list" && node.children.length > 0,
  );
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function diagnostic(
  issueNumber: number,
  code: PlanDiagnostic["code"],
  section: TicketSection | null,
  line: number | null,
  details: Readonly<Record<string, string | number>>,
): PlanDiagnostic {
  return { severity: "error", code, issueNumber, section, line, details };
}
