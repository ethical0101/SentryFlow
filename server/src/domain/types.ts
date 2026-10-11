import type { RiskLevel, ToolCategory } from "./catalog.js";

export type Decision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
export const DECISION_ORDER: Record<Decision, number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 };

export type Role = "agent" | "approver";

export interface Principal {
  role: Role;
  id: string;
}

/** A user constraint extracted deterministically from the request text. Only ever tightens policy. */
export interface UserConstraint {
  id: string;
  categories: ToolCategory[];
  effect: Exclude<Decision, "ALLOW">;
  sourceText: string;
}

export interface RuleTrace {
  ruleId: string;
  matched: boolean;
}

export interface PolicyEvaluation {
  decision: Decision;
  risk: RiskLevel;
  ruleId: string;
  reason: string;
  policyVersion: string;
  /** Decision from the base policy before user constraints were applied. */
  baseDecision: Decision;
  constraintsApplied: string[];
  trace: RuleTrace[];
  evaluatedAt: string;
}

export type ApprovalStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "INVALIDATED"
  | "NOT_APPLICABLE";

export interface ApprovalEvent {
  at: string;
  event: "REQUESTED" | "APPROVED" | "REJECTED" | "EXPIRED" | "INVALIDATED" | "CONSUMED" | "WITHDRAWN";
  by?: string;
  argsHash?: string;
  note?: string;
}

export interface ApprovalState {
  status: ApprovalStatus;
  approvalId?: string;
  argsHash?: string;
  policyVersion?: string;
  requestedAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt?: string;
  consumedAt?: string;
  note?: string;
  history: ApprovalEvent[];
}

export type ExecutionStatus = "NOT_STARTED" | "BLOCKED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface ExecutionState {
  status: ExecutionStatus;
  attempts: number;
  blockedReason?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface PlannedAction {
  actionId: string;
  index: number;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  explanation: string;
  dependsOn: string[];
  validation: { ok: boolean; errors: string[] };
  risk: RiskLevel;
  policy: PolicyEvaluation;
  approval: ApprovalState;
  execution: ExecutionState;
  revision: number;
}

export interface PlannerInfo {
  provider: "ollama" | "rules";
  model?: string;
  requestedProvider: "auto" | "ollama" | "rules";
  fallbackReason?: string;
  latencyMs: number;
  droppedProposals: { reason: string; proposal: string }[];
}

export interface Plan {
  planId: string;
  request: string;
  createdAt: string;
  createdBy: string;
  planner: PlannerInfo;
  constraints: UserConstraint[];
  actions: PlannedAction[];
}

export class SentryError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "INVALID_ARGUMENT"
      | "FORBIDDEN"
      | "CONFLICT"
      | "DUPLICATE_EXECUTION"
      | "APPROVAL_MISMATCH"
      | "APPROVAL_EXPIRED"
      | "POLICY_DENIED"
      | "TOOL_FAILURE"
      | "INTERNAL",
    message: string,
  ) {
    super(message);
    this.name = "SentryError";
  }
}
