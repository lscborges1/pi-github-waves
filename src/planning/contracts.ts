import type {
  DependencyWaveGraph,
  PlannedBoundaryNode,
  PlannedSelectedNode,
} from "../graph/contracts.js";

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

export interface DiscoveredRepository {
  readonly worktreeRoot: string;
  readonly commonDir: string;
  readonly originUrl: string;
  readonly owner: string;
  readonly name: string;
}

export interface RemoteRepositorySnapshot {
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly defaultBranchTipOid: string;
}

export interface IssueSnapshot {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
}

export interface DependencySnapshot {
  readonly repositoryUrl: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly issueNodeId: string;
  readonly number: number;
}

export interface PullRequestCloserSnapshot {
  readonly nodeId: string;
  readonly repositoryNodeId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly url: string;
  readonly mergedAt: string | null;
  readonly mergeCommitOid: string | null;
  readonly baseBranch: string;
}

export type ClosureEventSnapshot =
  | {
      readonly kind: "reopened";
      readonly nodeId: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: "closed";
      readonly nodeId: string;
      readonly createdAt: string;
      readonly closer: PullRequestCloserSnapshot | null;
    };

export interface ClosureEventPage {
  readonly events: readonly ClosureEventSnapshot[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface DependencyPage {
  readonly dependencies: readonly DependencySnapshot[];
  readonly page: number;
  readonly hasNextPage: boolean;
}

export interface CommitComparisonSnapshot {
  readonly status: "ahead" | "behind" | "diverged" | "identical";
}

export interface RepositoryPort {
  discover(cwd: string): Promise<DiscoveredRepository>;
}

export interface GitHubReadPort {
  authenticate(): Promise<void>;
  getRepository(
    owner: string,
    name: string,
  ): Promise<RemoteRepositorySnapshot>;
  getIssue(
    owner: string,
    name: string,
    number: number,
  ): Promise<IssueSnapshot>;
  getBlockedBy(
    owner: string,
    name: string,
    number: number,
    page: number,
  ): Promise<DependencyPage>;
  getClosureEvents(
    owner: string,
    name: string,
    number: number,
    cursor: string | null,
  ): Promise<ClosureEventPage>;
  compareCommits(
    owner: string,
    name: string,
    baseOid: string,
    headOid: string,
  ): Promise<CommitComparisonSnapshot>;
}

export interface CompletionEvidence {
  readonly completed: boolean;
  readonly pullRequests: readonly {
    readonly number: number;
    readonly url: string;
    readonly mergedAt: string;
    readonly mergeCommitOid: string;
    readonly baseBranch: string;
    readonly reachable: boolean;
  }[];
}

export interface PlannedIssueV1 {
  readonly number: number;
  readonly nodeId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: "OPEN" | "CLOSED" | null;
  readonly labels: readonly string[];
  readonly updatedAt: string | null;
  readonly completion: CompletionEvidence;
  readonly graphNode: PlannedSelectedNode | null;
}

export interface PlannedBoundaryIssueV1 {
  readonly number: number;
  readonly nodeId: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: "OPEN" | "CLOSED" | null;
  readonly updatedAt: string | null;
  readonly completion: CompletionEvidence;
  readonly graphNode: PlannedBoundaryNode | null;
}

export interface PlanResultV1 {
  readonly plannerSchemaVersion: 1;
  readonly repository: RemoteRepositorySnapshot;
  readonly inputOrder: readonly number[];
  readonly maxConcurrency: 3;
  readonly selected: readonly PlannedIssueV1[];
  readonly boundary: readonly PlannedBoundaryIssueV1[];
  readonly edges: readonly {
    readonly blockerNumber: number;
    readonly blockedNumber: number;
  }[];
  readonly graph: DependencyWaveGraph | null;
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly runnable: boolean;
}

export type FatalCode =
  | "invalid_command"
  | "project_untrusted"
  | "unsupported_repository"
  | "not_authenticated"
  | "forbidden"
  | "rate_limited"
  | "network"
  | "timeout"
  | "resource_limit"
  | "invalid_response"
  | "process_failed";

export type CommandOutcome =
  | { readonly kind: "planned"; readonly plan: PlanResultV1 }
  | {
      readonly kind: "fatal";
      readonly code: FatalCode;
      readonly message: string;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly kind: "cancelled"; readonly message: string };

export interface PlanSelection {
  readonly inputOrder: readonly number[];
  readonly selectedNumbers: readonly number[];
  readonly diagnostics: readonly PlanDiagnostic[];
}

export interface PlanWavesInput {
  readonly cwd: string;
  readonly selection: PlanSelection;
}

export interface PlanningPorts {
  readonly repository: RepositoryPort;
  readonly github: GitHubReadPort;
}
