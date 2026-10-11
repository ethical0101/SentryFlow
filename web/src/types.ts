/** Shapes of the structuredContent returned by SentryFlow MCP tools (subset used by the UI). */

export type Decision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ApprovalStatus = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "INVALIDATED" | "NOT_APPLICABLE";
export type ExecutionStatus = "NOT_STARTED" | "BLOCKED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface PolicyEvaluation {
  decision: Decision;
  baseDecision: Decision;
  risk: Risk;
  ruleId: string;
  reason: string;
  policyVersion: string;
  constraintsApplied: string[];
  trace: { ruleId: string; matched: boolean }[];
  evaluatedAt: string;
}

export interface ApprovalEvent {
  at: string;
  event: string;
  by?: string;
  argsHash?: string;
  note?: string;
}

export interface Action {
  actionId: string;
  index: number;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  explanation: string;
  dependsOn: string[];
  validation: { ok: boolean; errors: string[] };
  risk: Risk;
  policy: PolicyEvaluation;
  approval: {
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
  };
  execution: {
    status: ExecutionStatus;
    attempts: number;
    blockedReason?: string;
    startedAt?: string;
    finishedAt?: string;
    result?: Record<string, unknown>;
    error?: string;
  };
  revision: number;
}

export interface Constraint {
  id: string;
  categories: string[];
  effect: "REQUIRE_APPROVAL" | "DENY";
  sourceText: string;
}

export interface Plan {
  planId: string;
  request: string;
  createdAt: string;
  createdBy: string;
  planner: {
    provider: "ollama" | "rules";
    model?: string;
    requestedProvider: string;
    fallbackReason?: string;
    latencyMs: number;
    droppedProposals: { reason: string; proposal: string }[];
  };
  constraints: Constraint[];
  actions: Action[];
}

export interface Household {
  simulated: true;
  lights: Record<string, { on: boolean; brightness: number }>;
  thermostat: { mode: string; targetC: number; currentC: number };
  locks: Record<string, { locked: boolean }>;
  security: { mode: string; changedAt: string };
  cameras: Record<string, { recording: boolean }>;
  routines: Record<string, { name: string; description: string; enabled: boolean; enabledAt?: string }>;
  orders: { orderId: string; sku: string; name: string; quantity: number; totalUsd: number; placedAt: string }[];
  faults: Record<string, string>;
  faultableDevices: string[];
  updatedAt: string;
}

export interface PendingApproval {
  planId: string;
  request: string;
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  explanation: string;
  risk: Risk;
  ruleId: string;
  reason: string;
  requestedAt?: string;
}

export interface AuditRecord {
  seq: number;
  ts: string;
  type: string;
  correlationId: string;
  actionId?: string;
  actor: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Integrity {
  ok: boolean;
  records: number;
  headHash: string;
  firstBrokenSeq?: number;
  problem?: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  tool: string;
  when?: { all?: { fact: string; op: string; value?: unknown }[]; any?: { fact: string; op: string; value?: unknown }[] };
  decision: Decision;
  risk: Risk;
}

export interface PolicyInfo {
  version: string;
  policy: { name: string; version: string; description?: string; rules: PolicyRule[] };
  tools: { name: string; description: string; categories: string[]; readOnly: boolean }[];
  approvalTtlSeconds: number;
}

export interface Receipt {
  receiptId: string;
  generatedAt: string;
  planId: string;
  request: string;
  createdAt: string;
  planner: Plan["planner"];
  policyVersion: string;
  constraints: (Constraint & { summary: string })[];
  summary: Record<"total" | "succeeded" | "failed" | "blocked" | "skipped" | "notStarted" | "denied" | "pendingApproval", number>;
  actions: {
    actionId: string;
    tool: string;
    args: Record<string, unknown>;
    argsHash: string;
    explanation: string;
    decision: Decision;
    ruleId: string;
    risk: Risk;
    policyVersion: string;
    approval: { status: ApprovalStatus; decidedBy?: string; decidedAt?: string; consumedAt?: string; approvalId?: string };
    execution: Action["execution"];
  }[];
  timeline: { seq: number; ts: string; type: string; actionId?: string; actor: string; hash: string }[];
  integrity: Integrity;
  text: string;
}

export interface Health {
  status: string;
  server: { name: string; version: string; uptimeSeconds: number; node: string };
  mcp: { endpoint: string; transport: string; protocolVersion: string; sessions: { agent: number; approver: number } };
  planner: { configured: string; model: string; effective: string; ollama: { reachable: boolean; modelInstalled: boolean; models: string[]; error?: string } };
  policy: { version: string; rules: number; approvalTtlSeconds: number };
  audit: Integrity;
  simulation: { notice: string };
}
