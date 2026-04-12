export type ProjectStatus = "active" | "paused" | "archived";
export type ProjectExecutionState =
  | "active"
  | "paused"
  | "blocked"
  | "waiting_for_credit"
  | "waiting_for_human";
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

export interface IProjectMetadata {
  readonly approvalPolicy: IProjectApprovalPolicy;
  readonly executionState: ProjectExecutionState;
  readonly metadata: Readonly<Record<string, string>>;
  readonly verificationCommands: readonly string[];
}

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
