import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOL_DEFS, TOOL_NAMES } from "../domain/catalog.js";
import { hasDangerousKeys } from "../domain/safety.js";
import { SentryError, type Principal } from "../domain/types.js";
import { describeAction, voiceSummary, type SentryFlowService } from "../service/sentryflow.js";

export const SERVER_INFO = { name: "sentryflow", version: "1.0.0" } as const;

export interface StatusProvider {
  (): Promise<Record<string, unknown>>;
}

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{6,32}$`), `Expected a ${prefix}_… identifier`);
const PlanId = id("plan").describe("Plan identifier returned by sentryflow_plan_request, e.g. plan_1a2b3c4d5e6f");
const ActionId = id("act").describe("Action identifier from the plan, e.g. act_1a2b3c4d5e6f");
// Dangerous keys are rejected on the raw value, before the record parser can consume them.
const ArgsObject = z
  .preprocess((v) => (hasDangerousKeys(v) ? Symbol("rejected") : v), z.record(z.unknown()))
  .describe("Tool arguments as a JSON object");

function ok(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(e: unknown): CallToolResult {
  const err = e instanceof SentryError ? e : new SentryError("INTERNAL", e instanceof Error ? e.message : String(e));
  // Internal errors are reported generically; details stay in the server log.
  const message = err.code === "INTERNAL" ? "Internal error" : err.message;
  if (err.code === "INTERNAL") console.error("[sentryflow] internal tool error:", e);
  return { isError: true, content: [{ type: "text", text: `${err.code}: ${message}` }], structuredContent: { error: { code: err.code, message } } };
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

function requireApprover(principal: Principal, svc: SentryFlowService, tool: string) {
  if (principal.role !== "approver") {
    svc.recordAuthFailure(principal.id, { attempted: tool, role: principal.role });
    throw new SentryError("FORBIDDEN", `${tool} requires the approver role; this session is authenticated as ${principal.role}`);
  }
}

/**
 * Builds one McpServer for one authenticated session. Every handler validates input with zod (via
 * the SDK) and delegates to the service, which performs the authoritative checks.
 */
export function createMcpServer(svc: SentryFlowService, principal: Principal, status: StatusProvider): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, logging: {} },
    instructions:
      "SentryFlow is a permission-aware execution layer for a SIMULATED household. Plan with sentryflow_plan_request, " +
      "then run allowed actions with sentryflow_execute_plan. Actions marked REQUIRE_APPROVAL stay blocked until the owner " +
      "approves them through an approver session. DENY decisions are final. You cannot grant approvals yourself.",
  });

  server.registerTool(
    "sentryflow_plan_request",
    {
      title: "Plan a household request",
      description:
        "Turn a natural-language household request into a structured action plan. Each action gets a deterministic policy decision " +
        "(ALLOW, REQUIRE_APPROVAL or DENY), a risk level, dependencies and an approval status. Nothing is executed. " +
        "Restrictions in the request (e.g. 'never unlock a door without approval') can only make the policy stricter.",
      inputSchema: {
        request: z.string().min(1).max(2000).describe("What the owner asked for, verbatim"),
        planner: z.enum(["auto", "ollama", "rules"]).optional().describe("auto (default): local Ollama model with deterministic fallback; rules: deterministic only"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ request, planner }) =>
      guard(async () => {
        const plan = await svc.createPlan(request, principal, planner ?? "auto");
        return ok({ plan, voiceSummary: voiceSummary(plan) }, voiceSummary(plan));
      }),
  );

  server.registerTool(
    "sentryflow_get_plan",
    {
      title: "Get a plan",
      description: "Return a plan with the current policy, approval and execution status of every action.",
      inputSchema: { planId: PlanId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ planId }) => guard(async () => {
      const plan = await svc.getPlan(planId);
      return ok({ plan }, `${plan.actions.length} actions for "${plan.request.slice(0, 80)}"`);
    }),
  );

  server.registerTool(
    "sentryflow_list_plans",
    {
      title: "List recent plans",
      description: "List the most recent plans, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Maximum number of plans (default 20)") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ limit }) => guard(async () => {
      const plans = await svc.listPlans(limit ?? 20);
      return ok({ plans }, `${plans.length} plan(s)`);
    }),
  );

  server.registerTool(
    "sentryflow_evaluate_action",
    {
      title: "Inspect a policy decision",
      description:
        "Dry-run the deterministic policy engine for a tool call against the current simulated state. Returns the decision, " +
        "matching rule, rule trace and policy version. Never executes anything.",
      inputSchema: {
        tool: z.enum(TOOL_NAMES).describe("Household tool name"),
        args: ArgsObject,
        planId: PlanId.optional().describe("Optional plan whose user constraints should also apply"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ tool, args, planId }) => guard(async () => {
      const ev = svc.evaluateProposal(tool, args, planId);
      return ok({ evaluation: ev }, `${tool}: ${ev.decision} (${ev.ruleId}) — ${ev.reason}`);
    }),
  );

  server.registerTool(
    "sentryflow_get_policy",
    {
      title: "Get the active policy",
      description: "Return the active policy rules (ordered, first match wins, default deny), its version, and the tool catalog.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => {
      const tools = Object.values(TOOL_DEFS).map((t) => ({ name: t.name, description: t.description, categories: t.categories, readOnly: t.readOnly }));
      return ok({ version: svc.policy.version, policy: svc.policy.doc, tools, approvalTtlSeconds: svc.approvalTtlSeconds }, `Policy ${svc.policy.version} with ${svc.policy.doc.rules.length} rules`);
    }),
  );

  server.registerTool(
    "sentryflow_get_device_state",
    {
      title: "Get simulated device state",
      description: "Return the current state of the SIMULATED household: lights, thermostat, locks, security, cameras, routines, simulated orders and injected faults.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => {
      const h = svc.household();
      const lightsOn = Object.entries(h.lights).filter(([, l]) => l.on).map(([k]) => k.replace(/_/g, " "));
      return ok({ household: h }, `Security ${h.security.mode.replace(/_/g, " ")}; thermostat ${h.thermostat.mode} ${h.thermostat.targetC}°C; lights on: ${lightsOn.join(", ") || "none"}.`);
    }),
  );

  server.registerTool(
    "sentryflow_update_action",
    {
      title: "Edit an action's arguments",
      description:
        "Change the arguments of a not-yet-executed action. The new arguments are validated and re-evaluated by policy. " +
        "Any existing approval is invalidated because it was bound to the previous arguments.",
      inputSchema: { planId: PlanId, actionId: ActionId, args: ArgsObject },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ planId, actionId, args }) => guard(async () => {
      const action = await svc.updateActionArgs(planId, actionId, args, principal);
      return ok({ action }, `Updated ${describeAction(action)}: ${action.policy.decision}, approval ${action.approval.status}`);
    }),
  );

  server.registerTool(
    "sentryflow_list_pending_approvals",
    {
      title: "List pending approvals",
      description: "List every action waiting for an owner decision, with the exact arguments and the argsHash the approver must confirm.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => {
      const pending = await svc.pendingApprovals();
      return ok({ pending }, pending.length ? `${pending.length} pending: ${pending.map((p) => describeAction(p)).join("; ")}` : "No pending approvals.");
    }),
  );

  server.registerTool(
    "sentryflow_request_approval",
    {
      title: "Request approval",
      description: "Ask the owner to approve an action again after its approval expired or was invalidated. Cannot be used for DENY decisions.",
      inputSchema: { planId: PlanId, actionId: ActionId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ planId, actionId }) => guard(async () => {
      const action = await svc.requestApproval(planId, actionId, principal);
      return ok({ action }, `Approval for "${describeAction(action)}" is ${action.approval.status}`);
    }),
  );

  server.registerTool(
    "sentryflow_resolve_approval",
    {
      title: "Approve or reject an action (approver only)",
      description:
        "Record the owner's decision on a pending action. Requires an APPROVER session. The argsHash must equal the hash shown " +
        "with the pending approval, binding the decision to those exact arguments. Approvals are single-use and expire.",
      inputSchema: {
        planId: PlanId,
        actionId: ActionId,
        decision: z.enum(["approve", "reject"]),
        argsHash: z.string().regex(/^[a-f0-9]{64}$/).describe("SHA-256 of the canonical tool+args the owner reviewed"),
        note: z.string().max(280).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ planId, actionId, decision, argsHash, note }) => guard(async () => {
      requireApprover(principal, svc, "sentryflow_resolve_approval");
      const action = await svc.resolveApproval(planId, actionId, { decision, argsHash, note }, principal);
      return ok({ action }, `${decision === "approve" ? "Approved" : "Rejected"}: ${describeAction(action)}${decision === "approve" ? ` — single use, valid for ${Math.round(svc.approvalTtlSeconds / 60)} min` : ""}`);
    }),
  );

  server.registerTool(
    "sentryflow_execute_action",
    {
      title: "Execute one action",
      description:
        "Execute a single action. Immediately before execution the server re-validates arguments, dependencies, the policy decision " +
        "against the current state, and the approval binding (hash, expiry, single use, policy version). Blocked actions are not run.",
      inputSchema: { planId: PlanId, actionId: ActionId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ planId, actionId }) => guard(async () => {
      const action = await svc.executeAction(planId, actionId, principal);
      const st = action.execution.status;
      return ok({ action }, st === "SUCCEEDED" ? `Done: ${describeAction(action)}.` : `${st}: ${action.execution.blockedReason ?? action.execution.error ?? ""}`);
    }),
  );

  server.registerTool(
    "sentryflow_execute_plan",
    {
      title: "Execute every runnable action in a plan",
      description:
        "Run all actions in dependency order. ALLOW actions and approved actions execute; pending ones stay BLOCKED; denied ones " +
        "never run; dependents of failed or rejected actions are SKIPPED. Safe to call again — finished actions are never re-run.",
      inputSchema: { planId: PlanId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ planId }) => guard(async () => {
      const summary = await svc.executePlan(planId, principal);
      const plan = await svc.getPlan(planId);
      const text = `Ran ${summary.succeeded.length}, failed ${summary.failed.length}, blocked ${summary.blocked.length}, skipped ${summary.skipped.length}.`;
      return ok({ summary, plan }, text);
    }),
  );

  server.registerTool(
    "sentryflow_get_receipt",
    {
      title: "Get an execution receipt",
      description: "Return a human-readable receipt for a plan: every action's decision, approval and result, the audit timeline and the audit-chain verification result.",
      inputSchema: { planId: PlanId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ planId }) => guard(async () => {
      const receipt = await svc.receipt(planId);
      return ok({ receipt }, receipt.text);
    }),
  );

  server.registerTool(
    "sentryflow_get_audit_log",
    {
      title: "Get the audit log",
      description: "Return append-only audit records (optionally for one plan) and verify the SHA-256 hash chain over the whole log.",
      inputSchema: {
        planId: PlanId.optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Most recent N records (default 200)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ planId, limit }) => guard(async () => {
      const log = svc.auditLog({ planId, limit: limit ?? 200 });
      return ok(log, `${log.records.length} records; chain ${log.integrity.ok ? "verified" : `BROKEN at #${log.integrity.firstBrokenSeq}`}`);
    }),
  );

  server.registerTool(
    "sentryflow_system_status",
    {
      title: "System status",
      description: "Report server, MCP, planner (Ollama) and audit status, and which role this session holds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => {
      const s = await status();
      return ok({ ...s, session: { role: principal.role, principal: principal.id } }, `SentryFlow ${SERVER_INFO.version}; you are ${principal.role}`);
    }),
  );

  server.registerTool(
    "sentryflow_reset_environment",
    {
      title: "Reset the simulation (approver only)",
      description: "Reset the SIMULATED household to its initial state, optionally clearing plans. The audit log is never cleared.",
      inputSchema: { clearPlans: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ clearPlans }) => guard(async () => {
      requireApprover(principal, svc, "sentryflow_reset_environment");
      const household = await svc.resetEnvironment(principal, clearPlans ?? false);
      return ok({ household }, "Simulation reset.");
    }),
  );

  server.registerTool(
    "sentryflow_set_device_fault",
    {
      title: "Inject a simulated device fault (approver only)",
      description: "Mark a SIMULATED device offline (or back online) to demonstrate tool failures and partial execution.",
      inputSchema: { deviceId: z.string().min(1).max(40), offline: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ deviceId, offline }) => guard(async () => {
      requireApprover(principal, svc, "sentryflow_set_device_fault");
      const household = await svc.setFault(deviceId, offline, principal);
      return ok({ household }, `${deviceId} is now ${offline ? "offline" : "online"}.`);
    }),
  );

  return server;
}
