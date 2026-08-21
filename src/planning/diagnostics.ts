import type { PlanDiagnostic } from "./contracts.js";
import { compareOpaqueId } from "../graph/compare.js";

export function sortPlanDiagnostics(
  diagnostics: readonly PlanDiagnostic[],
): readonly PlanDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const severity =
      a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1;
    return (
      severity ||
      compareNullableNumber(a.issueNumber, b.issueNumber) ||
      compareOpaqueId(a.code, b.code) ||
      compareNullableText(a.section, b.section) ||
      compareNullableNumber(a.line, b.line) ||
      compareOpaqueId(stableDetails(a.details), stableDetails(b.details))
    );
  });
}

function stableDetails(
  details: Readonly<Record<string, string | number>>,
): string {
  return Object.keys(details)
    .sort(compareOpaqueId)
    .map((key) => `${key}=${JSON.stringify(details[key])}`)
    .join(";");
}

function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareOpaqueId(a, b);
}
