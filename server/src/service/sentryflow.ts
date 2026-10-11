import { randomBytes } from "node:crypto";
import type { AuditLog, AuditType } from "../audit/audit.js";
import { isToolName, validateToolArgs, type RiskLevel } from "../domain/catalog.js";
import { actionHash } from "../domain/canonical.js";
import {
  SentryError,
  type ApprovalState,
  type Decision,
  type Plan,
  type PlannedAction,
  type PolicyEvaluation,
  type Principal,
  type UserConstraint,
} from "../domain/types.js";
import { executeTool, faultableDevices, initialHousehold, type HouseholdState } from "../environment/household.js";
import { describeConstraint, extractConstraints } from "../planner/constraints.js";
import type { Planner, PlannerMode } from "../planner/index.js";
import { evaluate, type LoadedPolicy } from "../policy/engine.js";
import type { JsonStore } from "../store/store.js";

export interface AppState {
  version: 1;
  household: HouseholdState;
  plans: Record<string, Plan>;
  planOrder: string[];
}

export function initialAppState(now: Date): AppState {
  return { version: 1, household: initialHousehold(now), plans: {}, planOrder: [] };
}

export interface ServiceDeps {
  store: JsonStore<AppState>;
  audit: AuditLog;
  planner: Planner;
  policy: LoadedPolicy;
  approvalTtlMs: number;
  now?: () => Date;
  id?: () => string;
}

export interface GateResult {
  ok: boolean;
  status?: "BLOCKED" | "SKIPPED";
  reason?: string;
}

export interface PlanExecutionSummary {
  planId: string;
  succeeded: string[];
  failed: string[];
  blocked: { actionId: string; reason: string }[];
  skipped: { actionId: string; reason: string }[];
  alreadyFinished: string[];
}

const MAX_REQUEST_CHARS = 2000;
const MAX_PLANS = 200;

export class SentryFlowService {
  private readonly store: JsonStore<AppState>;
  private readonly audit: AuditLog;
  private readonly planner: Planner;
  private _policy: LoadedPolicy;
  private readonly ttlMs: number;
  readonly now: () => Date;
  private readonly id: () => string;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.planner = deps.planner;
    this._policy = deps.policy;
    this.ttlMs = deps.approvalTtlMs;
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => randomBytes(6).toString("hex"));
  }

  get policy(): LoadedPolicy {
    return this._policy;
  }

  /** Replaces the active policy. Approvals bound to the previous version stop being valid. */
  setPolicy(p: LoadedPolicy) {
    this._policy = p;
  }

  get approvalTtlSeconds() {
    return Math.round(this.ttlMs / 1000);
  }

  /** Marks actions left RUNNING by a crash as FAILED; they are never silently retried. */
  async recover(): Promise<void> {
    const snap = this.store.snapshot();
    const stuck = Object.values(snap.plans).some((p) => p.actions.some((a) => a.execution.status === "RUNNING"));
    if (!stuck) return;
    await this.store.update((s) => {
      for (const plan of Object.values(s.plans))
        for (const a of plan.actions)
          if (a.execution.status === "RUNNING") {
            a.execution.status = "FAILED";
            a.execution.error = "Interrupted by server restart; not retried automatically.";
            this.log("EXECUTION_FAILED", plan.planId, "system", { reason: a.execution.error }, a.actionId);
          }
    });
  }

  // ───────────────────────────────── planning ─────────────────────────────────

  async createPlan(request: string, principal: Principal, mode: PlannerMode = "auto"): Promise<Plan> {
    const text = request.trim();
    if (!text) throw new SentryError("INVALID_ARGUMENT", "Request is empty");
    if (text.length > MAX_REQUEST_CHARS) throw new SentryError("INVALID_ARGUMENT", `Request exceeds ${MAX_REQUEST_CHARS} characters`);

    const planId = `plan_${this.id()}`;
    this.log("REQUEST_RECEIVED", planId, principal.id, { request: text, plannerMode: mode });

    const constraints = extractConstraints(text);
    const { proposals, info } = await this.planner.plan(text, mode);
    if (info.fallbackReason) this.log("PLANNER_FALLBACK", planId, "system", { reason: info.fallbackReason });

    return this.store.update((s) => {
      const now = this.now();
      const refToId = new Map<string, string>();
      const actions: PlannedAction[] = proposals.map((p, index) => {
        const actionId = `act_${this.id()}`;
        refToId.set(p.ref, actionId);
        const validation = validateToolArgs(p.tool, p.args);
        const args = validation.ok ? validation.args : boundedArgs(p.args);
        const policy = evaluate(this._policy, { tool: p.tool, args, state: s.household, constraints, now });
        const argsHash = actionHash(p.tool, args);
        return {
          actionId,
          index,
          tool: p.tool,
          args,
          argsHash,
          explanation: p.explanation || `Run ${p.tool}`,
          dependsOn: p.dependsOn.map((d) => refToId.get(d)).filter((d): d is string => !!d),
          validation: { ok: validation.ok, errors: validation.ok ? [] : validation.errors },
          risk: policy.risk,
          policy,
          approval: initialApproval(policy.decision, argsHash, now),
          execution: { status: "NOT_STARTED", attempts: 0 },
          revision: 1,
        };
      });

      const plan: Plan = { planId, request: text, createdAt: now.toISOString(), createdBy: principal.id, planner: info, constraints, actions };
      s.plans[planId] = plan;
      s.planOrder.push(planId);
      while (s.planOrder.length > MAX_PLANS) delete s.plans[s.planOrder.shift()!];

      this.log("PLAN_CREATED", planId, principal.id, {
        planner: info.provider,
        model: info.model,
        fallbackReason: info.fallbackReason,
        constraints: constraints.map((c) => ({ id: c.id, effect: c.effect, categories: c.categories, sourceText: c.sourceText })),
        actions: actions.map((a) => ({ actionId: a.actionId, tool: a.tool, args: a.args, argsHash: a.argsHash, dependsOn: a.dependsOn })),
        droppedProposals: info.droppedProposals,
      });
      for (const a of actions) {
        this.logPolicy(planId, a, "plan");
        if (a.approval.status === "PENDING") this.log("APPROVAL_REQUESTED", planId, "system", { argsHash: a.argsHash, ruleId: a.policy.ruleId }, a.actionId);
      }
      return structuredClone(plan);
    });
  }

  async getPlan(planId: string): Promise<Plan> {
    await this.sweepIfNeeded();
    const plan = this.store.snapshot().plans[planId];
    if (!plan) throw new SentryError("NOT_FOUND", `Plan ${planId} not found`);
    return plan;
  }

  async listPlans(limit = 20): Promise<Plan[]> {
    await this.sweepIfNeeded();
    const s = this.store.snapshot();
    return s.planOrder.slice(-limit).reverse().map((id) => s.plans[id]!).filter(Boolean);
  }

  /** Dry-run policy evaluation against the current state. Never executes anything. */
  evaluateProposal(tool: string, args: Record<string, unknown>, planId?: string): PolicyEvaluation & { validation: { ok: boolean; errors: string[] }; argsHash: string } {
    const s = this.store.snapshot();
    const constraints = planId ? (s.plans[planId]?.constraints ?? []) : [];
    const validation = validateToolArgs(tool, args);
    const evaluation = evaluate(this._policy, { tool, args: validation.ok ? validation.args : args, state: s.household, constraints, now: this.now() });
    return { ...evaluation, validation: { ok: validation.ok, errors: validation.ok ? [] : validation.errors }, argsHash: actionHash(tool, validation.ok ? validation.args : args) };
  }

  // ───────────────────────────────── editing ─────────────────────────────────

  async updateActionArgs(planId: string, actionId: string, newArgs: Record<string, unknown>, principal: Principal): Promise<PlannedAction> {
    return this.store.update((s) => {
      const now = this.now();
      const { plan, action } = find(s, planId, actionId);
      const rejected = action.execution.status === "SKIPPED" && action.approval.status === "REJECTED";
      if (!["NOT_STARTED", "BLOCKED"].includes(action.execution.status) && !rejected)
        throw new SentryError("CONFLICT", `Action is ${action.execution.status}; it can no longer be edited`);
      const v = validateToolArgs(action.tool, newArgs);
      if (!v.ok) throw new SentryError("INVALID_ARGUMENT", v.errors.join("; "));
      const newHash = actionHash(action.tool, v.args);
      if (newHash === action.argsHash) return structuredClone(action);

      const oldHash = action.argsHash;
      const previous = action.approval.status;
      action.args = v.args;
      action.argsHash = newHash;
      action.validation = { ok: true, errors: [] };
      action.revision += 1;
      action.execution = { status: "NOT_STARTED", attempts: action.execution.attempts };
      this.log("ACTION_UPDATED", planId, principal.id, { oldArgsHash: oldHash, newArgsHash: newHash, args: v.args, revision: action.revision }, actionId);

      // Any existing approval was for different arguments: it is void.
      if (["PENDING", "APPROVED", "EXPIRED", "REJECTED"].includes(previous)) {
        action.approval.history.push({ at: now.toISOString(), event: "INVALIDATED", argsHash: oldHash, note: "Arguments changed" });
        this.log("APPROVAL_INVALIDATED", planId, "system", { previousStatus: previous, oldArgsHash: oldHash, newArgsHash: newHash, reason: "arguments changed" }, actionId);
      }
      this.reevaluate(s, plan, action, now, "edit");
      const fresh = initialApproval(action.policy.decision, newHash, now, action.approval.history);
      action.approval = fresh;
      if (fresh.status === "PENDING") this.log("APPROVAL_REQUESTED", planId, "system", { argsHash: newHash, ruleId: action.policy.ruleId, reason: "re-requested after edit" }, actionId);
      return structuredClone(action);
    });
  }

  // ───────────────────────────────── approvals ─────────────────────────────────

  async requestApproval(planId: string, actionId: string, principal: Principal): Promise<PlannedAction> {
    return this.store.update((s) => {
      const now = this.now();
      this.sweep(s, now);
      const { plan, action } = find(s, planId, actionId);
      if (isTerminal(action)) throw new SentryError("CONFLICT", `Action is already ${action.execution.status}`);
      this.reevaluate(s, plan, action, now, "approval-request");
      if (action.policy.decision === "DENY") throw new SentryError("POLICY_DENIED", `Policy denies this action (${action.policy.ruleId}); approval cannot override a denial`);
      if (action.approval.status === "REJECTED") throw new SentryError("CONFLICT", "The owner rejected this action. Edit it to propose something different.");
      if (action.approval.status === "PENDING" || (action.approval.status === "APPROVED" && !action.approval.consumedAt)) return structuredClone(action);
      action.approval = initialApproval("REQUIRE_APPROVAL", action.argsHash, now, action.approval.history);
      this.log("APPROVAL_REQUESTED", planId, principal.id, { argsHash: action.argsHash, ruleId: action.policy.ruleId }, actionId);
      return structuredClone(action);
    });
  }

  async resolveApproval(
    planId: string,
    actionId: string,
    input: { decision: "approve" | "reject"; argsHash: string; note?: string },
    principal: Principal,
  ): Promise<PlannedAction> {
    if (principal.role !== "approver") {
      this.log("AUTHORIZATION_FAILED", planId, principal.id, { attempted: "resolve_approval", role: principal.role }, actionId);
      throw new SentryError("FORBIDDEN", "Only the approver role can resolve approvals");
    }
    return this.store.update((s) => {
      const now = this.now();
      this.sweep(s, now);
      const { plan, action } = find(s, planId, actionId);
      const ap = action.approval;
      if (isTerminal(action)) {
        this.log("APPROVAL_DENIED_ATTEMPT", planId, principal.id, { reason: `action is ${action.execution.status}` }, actionId);
        throw new SentryError("CONFLICT", `Action is already ${action.execution.status}; there is nothing to approve`);
      }
      if (ap.status !== "PENDING") {
        this.log("APPROVAL_DENIED_ATTEMPT", planId, principal.id, { reason: `approval is ${ap.status}`, consumed: !!ap.consumedAt }, actionId);
        throw new SentryError("CONFLICT", `No pending approval for this action (status ${ap.status}${ap.consumedAt ? ", already used" : ""})`);
      }
      if (input.argsHash !== action.argsHash || ap.argsHash !== action.argsHash) {
        this.log("APPROVAL_DENIED_ATTEMPT", planId, principal.id, { reason: "argsHash mismatch", presented: input.argsHash, current: action.argsHash }, actionId);
        throw new SentryError("APPROVAL_MISMATCH", "The arguments you reviewed are not the arguments of this action. Reload and review again.");
      }
      const note = input.note?.slice(0, 280);
      if (input.decision === "reject") {
        action.approval = { ...ap, status: "REJECTED", decidedAt: now.toISOString(), decidedBy: principal.id, note, history: [...ap.history, { at: now.toISOString(), event: "REJECTED", by: principal.id, argsHash: action.argsHash, note }] };
        action.execution = { ...action.execution, status: "SKIPPED", blockedReason: "Rejected by the owner" };
        this.log("APPROVAL_REJECTED", planId, principal.id, { argsHash: action.argsHash, note }, actionId);
        this.log("EXECUTION_SKIPPED", planId, "system", { reason: "Rejected by the owner" }, actionId);
        return structuredClone(action);
      }
      this.reevaluate(s, plan, action, now, "approval");
      if (action.policy.decision === "DENY") {
        this.log("APPROVAL_DENIED_ATTEMPT", planId, principal.id, { reason: "policy now denies", ruleId: action.policy.ruleId }, actionId);
        throw new SentryError("POLICY_DENIED", `Policy now denies this action (${action.policy.ruleId}): ${action.policy.reason}`);
      }
      const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
      action.approval = {
        ...ap,
        status: "APPROVED",
        approvalId: `apr_${this.id()}`,
        decidedAt: now.toISOString(),
        decidedBy: principal.id,
        expiresAt,
        policyVersion: this._policy.version,
        note,
        history: [...ap.history, { at: now.toISOString(), event: "APPROVED", by: principal.id, argsHash: action.argsHash, note }],
      };
      // The previous "awaiting approval" block no longer describes the action; it is ready to run.
      if (action.execution.status === "BLOCKED") action.execution = { status: "NOT_STARTED", attempts: action.execution.attempts };
      this.log("APPROVAL_GRANTED", planId, principal.id, { approvalId: action.approval.approvalId, argsHash: action.argsHash, expiresAt, policyVersion: this._policy.version, note }, actionId);
      return structuredClone(action);
    });
  }

  async pendingApprovals() {
    await this.sweepIfNeeded();
    const s = this.store.snapshot();
    return s.planOrder
      .slice()
      .reverse()
      .flatMap((pid) => {
        const p = s.plans[pid]!;
        return p.actions
          .filter((a) => a.approval.status === "PENDING" && !isTerminal(a))
          .map((a) => ({
            planId: p.planId,
            request: p.request,
            actionId: a.actionId,
            tool: a.tool,
            args: a.args,
            argsHash: a.argsHash,
            explanation: a.explanation,
            risk: a.risk,
            ruleId: a.policy.ruleId,
            reason: a.policy.reason,
            requestedAt: a.approval.requestedAt,
          }));
      });
  }

  // ───────────────────────────────── execution ─────────────────────────────────

  async executeAction(planId: string, actionId: string, principal: Principal): Promise<PlannedAction> {
    return this.store.update((s) => {
      const now = this.now();
      this.sweep(s, now);
      const { plan, action } = find(s, planId, actionId);
      if (isTerminal(action) || action.execution.status === "RUNNING") {
        this.log("DUPLICATE_EXECUTION_REJECTED", planId, principal.id, { status: action.execution.status }, actionId);
        throw new SentryError("DUPLICATE_EXECUTION", `Action already ${action.execution.status}; it will not run again`);
      }
      this.runOne(s, plan, action, now, principal);
      return structuredClone(action);
    });
  }

  async executePlan(planId: string, principal: Principal): Promise<PlanExecutionSummary> {
    return this.store.update((s) => {
      const now = this.now();
      this.sweep(s, now);
      const plan = s.plans[planId];
      if (!plan) throw new SentryError("NOT_FOUND", `Plan ${planId} not found`);
      const summary: PlanExecutionSummary = { planId, succeeded: [], failed: [], blocked: [], skipped: [], alreadyFinished: [] };
      for (const action of plan.actions) {
        if (isTerminal(action)) {
          summary.alreadyFinished.push(action.actionId);
          continue;
        }
        this.runOne(s, plan, action, now, principal);
        const st = action.execution.status;
        if (st === "SUCCEEDED") summary.succeeded.push(action.actionId);
        else if (st === "FAILED") summary.failed.push(action.actionId);
        else if (st === "SKIPPED") summary.skipped.push({ actionId: action.actionId, reason: action.execution.blockedReason ?? "" });
        else summary.blocked.push({ actionId: action.actionId, reason: action.execution.blockedReason ?? "" });
      }
      return summary;
    });
  }

  /** Gate + execute. Must be called inside the store lock. */
  private runOne(s: AppState, plan: Plan, action: PlannedAction, now: Date, principal: Principal) {
    const gate = this.gate(s, plan, action, now);
    if (!gate.ok) {
      action.execution = { ...action.execution, status: gate.status!, blockedReason: gate.reason };
      if (gate.status === "SKIPPED" && action.approval.status === "PENDING") {
        action.approval.status = "NOT_APPLICABLE";
        action.approval.history.push({ at: now.toISOString(), event: "WITHDRAWN", note: gate.reason });
        this.log("APPROVAL_WITHDRAWN", plan.planId, "system", { reason: gate.reason }, action.actionId);
      }
      this.log(gate.status === "SKIPPED" ? "EXECUTION_SKIPPED" : "EXECUTION_BLOCKED", plan.planId, principal.id, { reason: gate.reason, decision: action.policy.decision, ruleId: action.policy.ruleId }, action.actionId);
      return;
    }

    if (action.approval.status === "APPROVED") {
      action.approval.consumedAt = now.toISOString();
      action.approval.history.push({ at: now.toISOString(), event: "CONSUMED", by: principal.id, argsHash: action.argsHash });
      this.log("APPROVAL_CONSUMED", plan.planId, principal.id, { approvalId: action.approval.approvalId, argsHash: action.argsHash }, action.actionId);
    }
    action.execution = { status: "RUNNING", attempts: action.execution.attempts + 1, startedAt: now.toISOString() };
    this.log("EXECUTION_STARTED", plan.planId, principal.id, { tool: action.tool, args: action.args, argsHash: action.argsHash, policyVersion: this._policy.version }, action.actionId);

    // Execute against a copy; commit only on success so a failing tool never half-applies.
    const scratch = structuredClone(s.household);
    try {
      const { result } = executeTool(scratch, action.tool as never, action.args, now, this.id);
      s.household = scratch;
      action.execution = { ...action.execution, status: "SUCCEEDED", finishedAt: now.toISOString(), result };
      this.log("EXECUTION_SUCCEEDED", plan.planId, principal.id, { tool: action.tool, result: summarizeResult(result) }, action.actionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      action.execution = { ...action.execution, status: "FAILED", finishedAt: now.toISOString(), error: msg };
      this.log("EXECUTION_FAILED", plan.planId, principal.id, { tool: action.tool, error: msg }, action.actionId);
    }
  }

  /**
   * The authorization gate. Everything is re-checked against the current state: arguments,
   * integrity hash, dependencies, policy, and the approval binding. Nothing from planning time
   * is trusted.
   */
  private gate(s: AppState, plan: Plan, action: PlannedAction, now: Date): GateResult {
    if (!isToolName(action.tool)) return { ok: false, status: "BLOCKED", reason: `Unknown tool ${action.tool}` };
    const v = validateToolArgs(action.tool, action.args);
    if (!v.ok) return { ok: false, status: "BLOCKED", reason: `Invalid arguments: ${v.errors.join("; ")}` };
    if (actionHash(action.tool, v.args) !== action.argsHash) return { ok: false, status: "BLOCKED", reason: "Integrity check failed: arguments do not match their recorded hash" };

    for (const depId of action.dependsOn) {
      const dep = plan.actions.find((a) => a.actionId === depId);
      if (!dep) return { ok: false, status: "SKIPPED", reason: `Dependency ${depId} is missing` };
      if (dep.execution.status === "SUCCEEDED") continue;
      if (["FAILED", "SKIPPED"].includes(dep.execution.status) || dep.policy.decision === "DENY" || dep.approval.status === "REJECTED")
        return { ok: false, status: "SKIPPED", reason: `Dependency ${depId} (${dep.tool}) did not succeed` };
      return { ok: false, status: "BLOCKED", reason: `Waiting for dependency ${depId} (${dep.tool})` };
    }

    this.reevaluate(s, plan, action, now, "execution");
    const decision = action.policy.decision;
    const ap = action.approval;

    if (decision === "DENY") return { ok: false, status: "BLOCKED", reason: `Denied by policy (${action.policy.ruleId}): ${action.policy.reason}` };

    // An owner's "no" or an open question always wins, whatever the policy now says.
    if (ap.status === "REJECTED") return { ok: false, status: "SKIPPED", reason: "Rejected by the owner" };
    if (ap.status === "PENDING") return { ok: false, status: "BLOCKED", reason: "Awaiting owner approval" };

    if (decision === "ALLOW") return { ok: true };

    // decision === REQUIRE_APPROVAL
    if (ap.status === "NOT_REQUIRED" || ap.status === "NOT_APPLICABLE") {
      action.approval = initialApproval("REQUIRE_APPROVAL", action.argsHash, now, ap.history);
      this.log("APPROVAL_REQUESTED", plan.planId, "system", { argsHash: action.argsHash, ruleId: action.policy.ruleId, reason: "approval became required at execution time" }, action.actionId);
      return { ok: false, status: "BLOCKED", reason: "Approval is now required (conditions changed since planning)" };
    }
    if (ap.status === "EXPIRED") return { ok: false, status: "BLOCKED", reason: "Approval expired; request a new approval" };
    if (ap.status === "INVALIDATED") return { ok: false, status: "BLOCKED", reason: "Approval was invalidated; request a new approval" };
    if (ap.status !== "APPROVED") return { ok: false, status: "BLOCKED", reason: `Approval status ${ap.status}` };

    if (ap.consumedAt) return { ok: false, status: "BLOCKED", reason: "Approval already used (replay rejected)" };
    if (!ap.expiresAt || new Date(ap.expiresAt).getTime() <= now.getTime()) {
      this.expire(plan, action, now);
      return { ok: false, status: "BLOCKED", reason: "Approval expired; request a new approval" };
    }
    if (ap.argsHash !== action.argsHash) {
      this.invalidate(plan, action, now, "arguments differ from the approved arguments");
      return { ok: false, status: "BLOCKED", reason: "Approval does not match current arguments" };
    }
    if (ap.policyVersion !== this._policy.version) {
      this.invalidate(plan, action, now, `policy changed from ${ap.policyVersion} to ${this._policy.version}`);
      return { ok: false, status: "BLOCKED", reason: "Policy changed since approval; re-approval required" };
    }
    return { ok: true };
  }

  private reevaluate(s: AppState, plan: Plan, action: PlannedAction, now: Date, phase: string) {
    const before = action.policy;
    const after = evaluate(this._policy, { tool: action.tool, args: action.args, state: s.household, constraints: plan.constraints, now });
    action.policy = after;
    action.risk = after.risk;
    if (before.decision !== after.decision || before.ruleId !== after.ruleId || before.policyVersion !== after.policyVersion) {
      this.logPolicy(plan.planId, action, phase, { previousDecision: before.decision, previousRuleId: before.ruleId });
    }
  }

  private expire(plan: Plan, action: PlannedAction, now: Date) {
    action.approval.status = "EXPIRED";
    action.approval.history.push({ at: now.toISOString(), event: "EXPIRED", argsHash: action.approval.argsHash });
    this.log("APPROVAL_EXPIRED", plan.planId, "system", { approvalId: action.approval.approvalId, expiresAt: action.approval.expiresAt }, action.actionId);
  }

  private invalidate(plan: Plan, action: PlannedAction, now: Date, reason: string) {
    action.approval.status = "INVALIDATED";
    action.approval.history.push({ at: now.toISOString(), event: "INVALIDATED", argsHash: action.approval.argsHash, note: reason });
    this.log("APPROVAL_INVALIDATED", plan.planId, "system", { approvalId: action.approval.approvalId, reason }, action.actionId);
  }

  /** Expires unconsumed approvals whose TTL has passed. Must run inside the lock. */
  private sweep(s: AppState, now: Date): boolean {
    let changed = false;
    for (const plan of Object.values(s.plans))
      for (const a of plan.actions)
        if (a.approval.status === "APPROVED" && !a.approval.consumedAt && a.approval.expiresAt && new Date(a.approval.expiresAt) <= now) {
          this.expire(plan, a, now);
          changed = true;
        }
    return changed;
  }

  private async sweepIfNeeded() {
    const now = this.now();
    const snap = this.store.snapshot();
    const due = Object.values(snap.plans).some((p) =>
      p.actions.some((a) => a.approval.status === "APPROVED" && !a.approval.consumedAt && a.approval.expiresAt && new Date(a.approval.expiresAt) <= now),
    );
    if (due) await this.store.update((s) => void this.sweep(s, this.now()));
  }

  // ───────────────────────────────── environment ─────────────────────────────────

  household(): HouseholdState & { faultableDevices: string[] } {
    const h = this.store.snapshot().household;
    return { ...h, faultableDevices: faultableDevices(h) };
  }

  async resetEnvironment(principal: Principal, clearPlans: boolean) {
    if (principal.role !== "approver") throw new SentryError("FORBIDDEN", "Only the approver/operator role can reset the environment");
    await this.store.update((s) => {
      s.household = initialHousehold(this.now());
      if (clearPlans) {
        s.plans = {};
        s.planOrder = [];
      }
      this.log("ENVIRONMENT_RESET", "system", principal.id, { clearPlans });
    });
    return this.household();
  }

  async setFault(deviceId: string, offline: boolean, principal: Principal) {
    if (principal.role !== "approver") throw new SentryError("FORBIDDEN", "Only the approver/operator role can inject simulated faults");
    await this.store.update((s) => {
      if (!faultableDevices(s.household).includes(deviceId)) throw new SentryError("INVALID_ARGUMENT", `Unknown device ${deviceId}`);
      if (offline) s.household.faults[deviceId] = "offline";
      else delete s.household.faults[deviceId];
      this.log("DEVICE_FAULT_CHANGED", "system", principal.id, { deviceId, offline });
    });
    return this.household();
  }

  // ───────────────────────────────── audit & receipts ─────────────────────────────────

  auditLog(filter: { planId?: string; limit?: number }) {
    return { records: this.audit.list({ correlationId: filter.planId, limit: filter.limit }), integrity: this.audit.verify() };
  }

  recordAuthFailure(actor: string, data: Record<string, unknown>) {
    this.log("AUTHORIZATION_FAILED", "system", actor, data);
  }

  async receipt(planId: string) {
    const plan = await this.getPlan(planId);
    const integrity = this.audit.verify();
    const events = this.audit.list({ correlationId: planId });
    const count = (pred: (a: PlannedAction) => boolean) => plan.actions.filter(pred).length;
    return {
      receiptId: `rcpt_${planId}`,
      generatedAt: this.now().toISOString(),
      planId,
      request: plan.request,
      createdAt: plan.createdAt,
      planner: plan.planner,
      policyVersion: this._policy.version,
      constraints: plan.constraints.map((c) => ({ ...c, summary: describeConstraint(c) })),
      summary: {
        total: plan.actions.length,
        succeeded: count((a) => a.execution.status === "SUCCEEDED"),
        failed: count((a) => a.execution.status === "FAILED"),
        blocked: count((a) => a.execution.status === "BLOCKED"),
        skipped: count((a) => a.execution.status === "SKIPPED"),
        notStarted: count((a) => a.execution.status === "NOT_STARTED"),
        denied: count((a) => a.policy.decision === "DENY"),
        pendingApproval: count((a) => a.approval.status === "PENDING"),
      },
      actions: plan.actions.map((a) => ({
        actionId: a.actionId,
        tool: a.tool,
        args: a.args,
        argsHash: a.argsHash,
        explanation: a.explanation,
        decision: a.policy.decision,
        ruleId: a.policy.ruleId,
        risk: a.risk,
        policyVersion: a.policy.policyVersion,
        approval: { status: a.approval.status, decidedBy: a.approval.decidedBy, decidedAt: a.approval.decidedAt, consumedAt: a.approval.consumedAt, approvalId: a.approval.approvalId },
        execution: a.execution,
      })),
      timeline: events.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actionId: e.actionId, actor: e.actor, hash: e.hash })),
      integrity,
      text: receiptText(plan),
    };
  }

  // ───────────────────────────────── helpers ─────────────────────────────────

  private log(type: AuditType, correlationId: string, actor: string, data: Record<string, unknown> = {}, actionId?: string) {
    this.audit.append({ type, correlationId, actor, data, actionId, ts: this.now() });
  }

  private logPolicy(planId: string, a: PlannedAction, phase: string, extra: Record<string, unknown> = {}) {
    this.log(
      "POLICY_EVALUATED",
      planId,
      "policy-engine",
      { phase, tool: a.tool, argsHash: a.argsHash, decision: a.policy.decision, baseDecision: a.policy.baseDecision, ruleId: a.policy.ruleId, risk: a.policy.risk, policyVersion: a.policy.policyVersion, constraintsApplied: a.policy.constraintsApplied, ...extra },
      a.actionId,
    );
  }
}

// ───────────────────────────────── module helpers ─────────────────────────────────

function find(s: AppState, planId: string, actionId: string) {
  const plan = s.plans[planId];
  if (!plan) throw new SentryError("NOT_FOUND", `Plan ${planId} not found`);
  const action = plan.actions.find((a) => a.actionId === actionId);
  if (!action) throw new SentryError("NOT_FOUND", `Action ${actionId} not found in ${planId}`);
  return { plan, action };
}

function isTerminal(a: PlannedAction) {
  return ["SUCCEEDED", "FAILED", "SKIPPED"].includes(a.execution.status);
}

function initialApproval(decision: Decision, argsHash: string, now: Date, history: ApprovalState["history"] = []): ApprovalState {
  if (decision === "REQUIRE_APPROVAL")
    return { status: "PENDING", argsHash, requestedAt: now.toISOString(), history: [...history, { at: now.toISOString(), event: "REQUESTED", argsHash }] };
  return { status: decision === "ALLOW" ? "NOT_REQUIRED" : "NOT_APPLICABLE", history: [...history] };
}

/** Invalid model arguments are kept for display, but bounded in size. */
function boundedArgs(args: unknown): Record<string, unknown> {
  const json = JSON.stringify(args ?? {}) ?? "{}";
  if (json.length > 500) return { _truncated: json.slice(0, 500) };
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : { _value: json };
}

function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
  // Device snapshots are large; the audit keeps a marker instead of the full copy.
  if ("snapshot" in result) return { snapshot: "[device snapshot omitted]" };
  return result;
}

const TOOL_PHRASES: Record<string, (a: Record<string, unknown>) => string> = {
  set_light: (a) => `turn ${a.lightId === "all" ? "all lights" : `the ${String(a.lightId).replace(/_/g, " ")} light`} ${a.on ? "on" : "off"}`,
  set_thermostat: (a) => `set the thermostat to ${String(a.mode)}${a.targetC !== undefined ? ` at ${String(a.targetC)}°C` : ""}`,
  lock_door: (a) => `lock the ${String(a.doorId).replace(/_/g, " ")}`,
  unlock_door: (a) => `unlock the ${String(a.doorId).replace(/_/g, " ")}`,
  set_security_mode: (a) => (a.mode === "disarmed" ? "disarm security" : `arm security (${String(a.mode).replace(/_/g, " ")})`),
  set_camera_recording: (a) => `${a.recording ? "start" : "stop"} recording on the ${String(a.cameraId).replace(/_/g, " ").replace(" cam", " camera")}`,
  enable_routine: (a) => `enable the ${String(a.routineId).replace(/_/g, " ")} routine`,
  purchase_item: (a) => `order ${String(a.quantity)} × ${String(a.sku).replace(/_/g, " ")}`,
  get_device_state: () => "check device state",
  get_security_status: () => "check security status",
};

export function describeAction(a: Pick<PlannedAction, "tool" | "args">): string {
  return TOOL_PHRASES[a.tool]?.(a.args) ?? a.tool;
}

/** A short, speakable summary in the style of an assistant response. */
export function voiceSummary(plan: Plan): string {
  const allow = plan.actions.filter((a) => a.policy.decision === "ALLOW");
  const approval = plan.actions.filter((a) => a.policy.decision === "REQUIRE_APPROVAL");
  const deny = plan.actions.filter((a) => a.policy.decision === "DENY");
  if (plan.actions.length === 0) return "I couldn't find anything I can do for that request.";
  const parts = [`I planned ${plan.actions.length} action${plan.actions.length === 1 ? "" : "s"}.`];
  if (allow.length) parts.push(`I can ${allow.map(describeAction).join(", ")}.`);
  if (approval.length) parts.push(`I need your approval to ${approval.map(describeAction).join(" and ")}.`);
  if (deny.length) parts.push(`I won't ${deny.map(describeAction).join(" or ")} — policy doesn't allow it.`);
  return parts.join(" ");
}

function receiptText(plan: Plan): string {
  const lines = [`Receipt for "${plan.request}"`];
  for (const a of plan.actions) {
    const st = a.execution.status;
    const tail = st === "SUCCEEDED" ? "done" : st === "FAILED" ? `failed: ${a.execution.error}` : a.execution.blockedReason ?? st.toLowerCase().replace("_", " ");
    lines.push(`• ${describeAction(a)} — ${a.policy.decision.toLowerCase().replace("_", " ")} → ${tail}`);
  }
  return lines.join("\n");
}

export type { RiskLevel, UserConstraint };
