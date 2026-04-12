export type ProjectStatus = "active" | "paused" | "archived";
export type ProjectExecutionState =
  | "active"
  | "paused"
  | "blocked"
  | "waiting_for_credit"
  | "waiting_for_human";
export type ProjectPlanningLoopKind =
  | "idle_backlog_generation"
  | "security_audit"
  | "best_practices"
  | "custom";
export type ProjectPlanningLoopTrigger = "idle" | "blocked_or_waiting";
export type BacklogItemStatus =
  | "draft"
  | "approved"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";
export type BacklogItemReadiness = "not_ready" | "ready";
export type RiskLevel = "low" | "medium" | "high";
export type ReviewMode = "human" | "ai";
export type WorkerKind = "claude" | "codex";
export type WorkerSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "exited"
  | "failed";
export type TaskRunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "awaiting_review"
  | "done"
  | "failed"
  | "cancelled";
export type BlockerType = "policy" | "helper_model" | "human" | "system";
export type BlockerStatus = "open" | "resolved";
export type ApprovalRequester = "system" | "claude" | "codex" | "human";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "deferred";
export type ChatThreadKind =
  | "project_planning"
  | "task_planning"
  | "project_operator"
  | "task_operator";
export type ChatThreadStatus = "open" | "closed" | "archived";
export type ChatMessageRole = "system" | "human" | "claude" | "codex" | "assistant" | "tool";
export type MemoryNoteType = "fact" | "decision" | "note" | "session_summary";
export type VerificationRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled";
export type ReviewRunStatus = "queued" | "running" | "approved" | "changes_requested" | "failed";

export interface IProjectApprovalPolicy {
  readonly requireApprovalForHighRiskTasks: boolean;
  readonly requireApprovalForNewBacklogItems: boolean;
  readonly requireApprovalForScopeChanges: boolean;
}

export interface IProjectPlanningLoop {
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: ProjectPlanningLoopKind;
  readonly prompt: string;
  readonly title: string;
  readonly trigger: ProjectPlanningLoopTrigger;
}

export interface IProjectMetadata {
  readonly approvalPolicy: IProjectApprovalPolicy;
  readonly executionState: ProjectExecutionState;
  readonly metadata: Readonly<Record<string, string>>;
  readonly planningLoops: readonly IProjectPlanningLoop[];
  readonly verificationCommands: readonly string[];
}

export const DEFAULT_PROJECT_PLANNING_LOOPS: readonly IProjectPlanningLoop[] = [
  {
    enabled: true,
    id: "loop-idle-backlog-generation",
    kind: "idle_backlog_generation",
    prompt: [
      "Run the default idle backlog-generation loop for this project.",
      "The project is blocked or waiting on something external before coding can resume.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Instead, identify a small set of useful draft backlog items or draft refinements that can move the project forward while execution is waiting.",
      "Prefer reviewable work that reduces risk, prepares follow-on execution, or addresses likely unblockers.",
      "Use Smithly MCP tools to record the drafted work and explain briefly why each item helps.",
    ].join(" "),
    title: "Idle backlog generation",
    trigger: "blocked_or_waiting",
  },
  {
    enabled: true,
    id: "loop-security-audit",
    kind: "security_audit",
    prompt: [
      "Run the default security-audit loop for this project.",
      "Review the full codebase for concrete security weaknesses, insecure defaults, secrets handling risks, authorization gaps, dependency exposure, and unsafe operational assumptions.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Draft a small set of human-reviewed backlog items for the highest-value security follow-ups you find.",
      "Each draft should explain the risk, the likely impact, and the smallest pragmatic remediation slice.",
      "Use Smithly MCP tools to record the backlog items with human review mode.",
    ].join(" "),
    title: "Security audit",
    trigger: "idle",
  },
  {
    enabled: true,
    id: "loop-best-practices-2026",
    kind: "best_practices",
    prompt: [
      "Run the default pragmatic 2026 best-practices loop for this project.",
      "Review the current codebase against pragmatic 2026 engineering practices, including maintainability, testing depth, developer ergonomics, operational resilience, dependency hygiene, and workflow clarity.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Draft a small set of human-reviewed backlog items for the highest-leverage improvements you find.",
      "Each draft should explain the current gap, the practical benefit of fixing it in 2026, and the smallest useful implementation slice.",
      "Use Smithly MCP tools to record the backlog items with human review mode.",
    ].join(" "),
    title: "Pragmatic 2026 best practices",
    trigger: "idle",
  },
];

export interface IProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: ProjectStatus;
  readonly defaultBranch?: string;
  readonly metadataJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IBacklogItemRecord {
  readonly id: string;
  readonly projectId: string;
  readonly parentBacklogItemId?: string;
  readonly title: string;
  readonly status: BacklogItemStatus;
  readonly readiness: BacklogItemReadiness;
  readonly priority: number;
  readonly scopeSummary?: string;
  readonly acceptanceCriteriaJson: string;
  readonly riskLevel: RiskLevel;
  readonly reviewMode: ReviewMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IBacklogDependencyRecord {
  readonly projectId: string;
  readonly blockingBacklogItemId: string;
  readonly blockedBacklogItemId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IWorkerSessionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workerKind: WorkerKind;
  readonly status: WorkerSessionStatus;
  readonly terminalKey?: string;
  readonly transcriptRef?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ITaskRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly backlogItemId: string;
  readonly workerSessionId?: string;
  readonly assignedWorker: WorkerKind;
  readonly status: TaskRunStatus;
  readonly summaryText?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface IBlockerRecord {
  readonly id: string;
  readonly projectId: string;
  readonly backlogItemId?: string;
  readonly taskRunId?: string;
  readonly blockerType: BlockerType;
  readonly status: BlockerStatus;
  readonly title: string;
  readonly detail: string;
  readonly resolutionNote?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export interface IApprovalRecord {
  readonly id: string;
  readonly projectId: string;
  readonly backlogItemId?: string;
  readonly taskRunId?: string;
  readonly requestedBy: ApprovalRequester;
  readonly decisionBy?: string;
  readonly status: ApprovalStatus;
  readonly title: string;
  readonly detail: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt?: string;
}

export interface IChatThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly backlogItemId?: string;
  readonly title: string;
  readonly kind: ChatThreadKind;
  readonly status: ChatThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IChatMessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly role: ChatMessageRole;
  readonly bodyText: string;
  readonly metadataJson: string;
  readonly createdAt: string;
}

export interface IMemoryNoteRecord {
  readonly id: string;
  readonly projectId: string;
  readonly backlogItemId?: string;
  readonly taskRunId?: string;
  readonly sourceThreadId?: string;
  readonly noteType: MemoryNoteType;
  readonly title: string;
  readonly bodyText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IVerificationRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskRunId: string;
  readonly status: VerificationRunStatus;
  readonly commandText: string;
  readonly summaryText?: string;
  readonly artifactPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface IReviewRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskRunId: string;
  readonly reviewerKind: "human" | "claude" | "codex";
  readonly status: ReviewRunStatus;
  readonly summaryText?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}
