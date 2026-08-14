export type TicketSection =
  | "context"
  | "objective"
  | "scope"
  | "outOfScope"
  | "expectedBehavior"
  | "technicalNotes"
  | "acceptanceCriteria"
  | "testScenarios";

export type PlanDiagnosticCode =
  | "duplicate_input"
  | "issue_missing"
  | "issue_unreadable"
  | "issue_closed_uncompleted"
  | "label_missing"
  | "label_conflict"
  | "body_too_large"
  | "missing_section"
  | "duplicate_section"
  | "empty_section"
  | "missing_list_item"
  | "dependency_cross_repository"
  | "boundary_limit_exceeded"
  | "edge_limit_exceeded"
  | "dependency_cycle"
  | "external_blocker_open";

export interface PlanDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: PlanDiagnosticCode;
  readonly issueNumber: number | null;
  readonly section: TicketSection | null;
  readonly line: number | null;
  readonly details: Readonly<Record<string, string | number>>;
}
