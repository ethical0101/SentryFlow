import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy/engine.js";
import { AGENT, DEMO_REQUEST, defaultPolicy, makeService, modelReturning, OWNER } from "./helpers.js";

const byTool = <T extends { tool: string }>(xs: T[], tool: string) => xs.find((x) => x.tool === tool)!;

describe("plan creation", () => {
  it("builds a fully annotated plan from the demo request", async () => {
    const { svc } = makeService();
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    expect(plan.planner.provider).toBe("rules");
    expect(plan.constraints).toHaveLength(1);
    for (const a of plan.actions) {
      expect(a.actionId).toMatch(/^act_/);
      expect(a.argsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(a.explanation).toBeTruthy();
      expect(a.execution.status).toBe("NOT_STARTED");
    }
    expect(byTool(plan.actions, "set_light").policy.decision).toBe("ALLOW");
    expect(byTool(plan.actions, "purchase_item")).toMatchObject({ policy: { decision: "REQUIRE_APPROVAL" }, approval: { status: "PENDING" } });
    expect(byTool(plan.actions, "set_camera_recording")).toMatchObject({ policy: { decision: "DENY" }, approval: { status: "NOT_APPLICABLE" } });
    const routine = byTool(plan.actions, "enable_routine");
    expect(routine.dependsOn).toEqual([byTool(plan.actions, "set_light").actionId, byTool(plan.actions, "set_thermostat").actionId]);
  });

  it("keeps invalid model proposals visible but denied", async () => {
    const { svc } = makeService({
      modelCall: modelReturning([
        { id: "a1", tool: "set_light", args: { lightId: "attic", on: true }, explanation: "", dependsOn: [] },
        { id: "a2", tool: "self_destruct", args: {}, explanation: "", dependsOn: [] },
      ]),
    });
    const plan = await svc.createPlan("whatever", AGENT);
    expect(plan.planner.provider).toBe("ollama");
    expect(plan.actions[0]).toMatchObject({ validation: { ok: false }, policy: { decision: "DENY", ruleId: "schema.invalid_args" } });
    expect(plan.actions[1]).toMatchObject({ policy: { decision: "DENY", ruleId: "catalog.unknown_tool" } });
  });

  it("rejects empty and oversized requests", async () => {
    const { svc } = makeService();
    await expect(svc.createPlan("   ", AGENT)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(svc.createPlan("x".repeat(2001), AGENT)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("execution gates", () => {
  it("ALLOW actions change real state; REQUIRE_APPROVAL stays blocked; DENY never executes", async () => {
    const { svc } = makeService();
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    const summary = await svc.executePlan(plan.planId, AGENT);
    const after = await svc.getPlan(plan.planId);
    const h = svc.household();

    expect(Object.values(h.lights).every((l) => !l.on)).toBe(true);
    expect(h.thermostat.mode).toBe("eco");
    expect(h.routines.leaving_home!.enabled).toBe(true);
    expect(summary.succeeded).toHaveLength(3);

    expect(byTool(after.actions, "purchase_item").execution).toMatchObject({ status: "BLOCKED", blockedReason: "Awaiting owner approval" });
    expect(h.orders).toHaveLength(0);

    expect(byTool(after.actions, "set_camera_recording").execution.status).toBe("BLOCKED");
    expect(h.cameras.backyard_cam!.recording).toBe(true);
  });

  it("an approved action executes exactly once", async () => {
    const { svc } = makeService();
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    const p = byTool(plan.actions, "purchase_item");
    await svc.resolveApproval(plan.planId, p.actionId, { decision: "approve", argsHash: p.argsHash }, OWNER);
    const done = await svc.executeAction(plan.planId, p.actionId, AGENT);
    expect(done.execution.status).toBe("SUCCEEDED");
    expect(done.approval.consumedAt).toBeTruthy();
    expect(svc.household().orders).toHaveLength(1);

    await expect(svc.executeAction(plan.planId, p.actionId, AGENT)).rejects.toMatchObject({ code: "DUPLICATE_EXECUTION" });
    await svc.executePlan(plan.planId, AGENT);
    expect(svc.household().orders).toHaveLength(1);
  });

  it("a denied action cannot be approved or executed", async () => {
    const { svc } = makeService();
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    const cam = byTool(plan.actions, "set_camera_recording");
    await expect(svc.resolveApproval(plan.planId, cam.actionId, { decision: "approve", argsHash: cam.argsHash }, OWNER)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(svc.requestApproval(plan.planId, cam.actionId, AGENT)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    for (let i = 0; i < 3; i++) await svc.executeAction(plan.planId, cam.actionId, AGENT);
    expect(svc.household().cameras.backyard_cam!.recording).toBe(true);
  });

  it("rejected actions are skipped, and so are their dependents", async () => {
    const { svc } = makeService({
      modelCall: modelReturning([
        { id: "a1", tool: "unlock_door", args: { doorId: "back_door" }, explanation: "let the dog walker in", dependsOn: [] },
        { id: "a2", tool: "set_light", args: { lightId: "porch", on: true }, explanation: "light the path", dependsOn: ["a1"] },
      ]),
    });
    const plan = await svc.createPlan("let the dog walker in", AGENT);
    const [unlock, light] = plan.actions;
    await svc.resolveApproval(plan.planId, unlock!.actionId, { decision: "reject", argsHash: unlock!.argsHash, note: "not today" }, OWNER);
    const s = await svc.executePlan(plan.planId, AGENT);
    expect(s.skipped.map((x) => x.actionId)).toEqual([light!.actionId]);
    const after = await svc.getPlan(plan.planId);
    expect(after.actions[0]!.approval).toMatchObject({ status: "REJECTED", decidedBy: "owner", note: "not today" });
  });

  it("partial execution: a failing tool fails alone and its dependents are skipped", async () => {
    const { svc } = makeService();
    await svc.setFault("thermostat", true, OWNER);
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    const s = await svc.executePlan(plan.planId, AGENT);
    const after = await svc.getPlan(plan.planId);
    expect(byTool(after.actions, "set_thermostat").execution).toMatchObject({ status: "FAILED", error: expect.stringContaining("offline") });
    expect(byTool(after.actions, "set_light").execution.status).toBe("SUCCEEDED");
    expect(byTool(after.actions, "enable_routine").execution.status).toBe("SKIPPED");
    expect(s.failed).toHaveLength(1);
    expect(svc.household().thermostat.mode).toBe("heat");
    expect(svc.household().routines.leaving_home!.enabled).toBe(false);
  });

  it("a blocked dependency keeps dependents waiting rather than skipping them", async () => {
    const { svc } = makeService({
      modelCall: modelReturning([
        { id: "a1", tool: "unlock_door", args: { doorId: "back_door" }, explanation: "", dependsOn: [] },
        { id: "a2", tool: "set_light", args: { lightId: "porch", on: true }, explanation: "", dependsOn: ["a1"] },
      ]),
    });
    const plan = await svc.createPlan("x", AGENT);
    await svc.executePlan(plan.planId, AGENT);
    const after = await svc.getPlan(plan.planId);
    expect(after.actions[1]!.execution).toMatchObject({ status: "BLOCKED", blockedReason: expect.stringContaining("Waiting for dependency") });
    const [unlock] = after.actions;
    await svc.resolveApproval(plan.planId, unlock!.actionId, { decision: "approve", argsHash: unlock!.argsHash }, OWNER);
    const s2 = await svc.executePlan(plan.planId, AGENT);
    expect(s2.succeeded).toHaveLength(2);
  });
});

describe("approval binding", () => {
  async function pendingPurchase(ttlMs?: number) {
    const ctx = makeService({ ttlMs });
    const plan = await ctx.svc.createPlan("Order 1 coffee beans", AGENT);
    return { ...ctx, plan, action: plan.actions[0]! };
  }

  it("only the approver role may approve", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await expect(svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, AGENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("approving a blocked action clears its stale 'awaiting approval' block", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await svc.executePlan(plan.planId, AGENT);
    expect((await svc.getPlan(plan.planId)).actions[0]!.execution).toMatchObject({ status: "BLOCKED", blockedReason: "Awaiting owner approval" });
    const approved = await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    expect(approved.execution.status).toBe("NOT_STARTED");
    expect(approved.execution.blockedReason).toBeUndefined();
  });

  it("the approver must present the hash of the exact arguments", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await expect(svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: "f".repeat(64) }, OWNER)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("editing arguments after approval invalidates the approval", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    const edited = await svc.updateActionArgs(plan.planId, action.actionId, { sku: "coffee_beans", quantity: 5 }, AGENT);
    expect(edited.approval.status).toBe("PENDING");
    expect(edited.approval.history.map((h) => h.event)).toEqual(["REQUESTED", "APPROVED", "INVALIDATED", "REQUESTED"]);
    const ran = await svc.executeAction(plan.planId, action.actionId, AGENT);
    expect(ran.execution.status).toBe("BLOCKED");
    expect(svc.household().orders).toHaveLength(0);
    // The old hash cannot approve the new arguments.
    await expect(svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("an edit that crosses a policy threshold is re-evaluated (5 → 6 coffee is over $100 → DENY)", async () => {
    const { svc, plan, action } = await pendingPurchase();
    const edited = await svc.updateActionArgs(plan.planId, action.actionId, { sku: "coffee_beans", quantity: 6 }, AGENT);
    expect(edited).toMatchObject({ policy: { decision: "DENY", ruleId: "purchase.over_limit" }, approval: { status: "NOT_APPLICABLE" } });
  });

  it("invalid edits are refused and leave the action untouched", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await expect(svc.updateActionArgs(plan.planId, action.actionId, { sku: "coffee_beans", quantity: 0 }, AGENT)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await svc.getPlan(plan.planId)).actions[0]!.argsHash).toBe(action.argsHash);
  });

  it("approvals expire", async () => {
    const { svc, clock, plan, action } = await pendingPurchase(60_000);
    await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    clock.advance(61_000);
    const ran = await svc.executeAction(plan.planId, action.actionId, AGENT);
    expect(ran.execution).toMatchObject({ status: "BLOCKED", blockedReason: expect.stringContaining("expired") });
    expect(ran.approval.status).toBe("EXPIRED");
    expect(svc.household().orders).toHaveLength(0);
    // A fresh request + approval works again.
    await svc.requestApproval(plan.planId, action.actionId, AGENT);
    await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    expect((await svc.executeAction(plan.planId, action.actionId, AGENT)).execution.status).toBe("SUCCEEDED");
  });

  it("an approval cannot be resolved twice (replay)", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    await expect(svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a policy change after approval requires re-approval", async () => {
    const { svc, plan, action } = await pendingPurchase();
    await svc.resolveApproval(plan.planId, action.actionId, { decision: "approve", argsHash: action.argsHash }, OWNER);
    const doc = structuredClone(defaultPolicy().doc);
    doc.version = "1.0.1";
    svc.setPolicy(loadPolicy(doc));
    const ran = await svc.executeAction(plan.planId, action.actionId, AGENT);
    expect(ran.execution.blockedReason).toMatch(/Policy changed/);
    expect(ran.approval.status).toBe("INVALIDATED");
  });

  it("state change between approval and execution is caught (unlock approved, then house armed away)", async () => {
    const { svc } = makeService({
      modelCall: modelReturning([
        { id: "a1", tool: "unlock_door", args: { doorId: "front_door" }, explanation: "", dependsOn: [] },
        { id: "a2", tool: "set_security_mode", args: { mode: "armed_away" }, explanation: "", dependsOn: [] },
      ]),
    });
    const plan = await svc.createPlan("x", AGENT);
    const [unlock, arm] = plan.actions;
    await svc.resolveApproval(plan.planId, unlock!.actionId, { decision: "approve", argsHash: unlock!.argsHash }, OWNER);
    await svc.executeAction(plan.planId, arm!.actionId, AGENT);
    const ran = await svc.executeAction(plan.planId, unlock!.actionId, AGENT);
    expect(ran.execution).toMatchObject({ status: "BLOCKED", blockedReason: expect.stringContaining("locks.unlock_while_away") });
    expect(svc.household().locks.front_door!.locked).toBe(true);
  });

  it("an ALLOW action that becomes approval-gated at execution time is held", async () => {
    const { svc } = makeService({ modelCall: modelReturning([{ id: "a1", tool: "set_light", args: { lightId: "all", on: false }, explanation: "", dependsOn: [] }]) });
    const plan = await svc.createPlan("x", AGENT);
    const doc = structuredClone(defaultPolicy().doc);
    doc.rules = doc.rules.map((r) => (r.id === "lighting.any" ? { ...r, decision: "REQUIRE_APPROVAL" as const } : r));
    svc.setPolicy(loadPolicy(doc));
    const ran = await svc.executeAction(plan.planId, plan.actions[0]!.actionId, AGENT);
    expect(ran).toMatchObject({ execution: { status: "BLOCKED" }, approval: { status: "PENDING" } });
  });
});

describe("audit consistency", () => {
  it("records every lifecycle event with correlation ids and a valid chain", async () => {
    const { svc } = makeService();
    const plan = await svc.createPlan(DEMO_REQUEST, AGENT);
    const p = byTool(plan.actions, "purchase_item");
    await svc.executePlan(plan.planId, AGENT);
    await svc.resolveApproval(plan.planId, p.actionId, { decision: "approve", argsHash: p.argsHash }, OWNER);
    await svc.executeAction(plan.planId, p.actionId, AGENT);
    const { records, integrity } = svc.auditLog({ planId: plan.planId });
    expect(integrity.ok).toBe(true);
    const types = records.map((r) => r.type);
    expect(types[0]).toBe("REQUEST_RECEIVED");
    for (const t of ["PLAN_CREATED", "POLICY_EVALUATED", "APPROVAL_REQUESTED", "EXECUTION_SUCCEEDED", "EXECUTION_BLOCKED", "APPROVAL_GRANTED", "APPROVAL_CONSUMED"])
      expect(types).toContain(t);
    // Exactly one successful execution per executed action.
    const successes = records.filter((r) => r.type === "EXECUTION_SUCCEEDED").map((r) => r.actionId);
    expect(new Set(successes).size).toBe(successes.length);
    // The audit agrees with the plan state.
    const after = await svc.getPlan(plan.planId);
    expect(successes.sort()).toEqual(after.actions.filter((a) => a.execution.status === "SUCCEEDED").map((a) => a.actionId).sort());
    const receipt = await svc.receipt(plan.planId);
    expect(receipt.summary).toMatchObject({ succeeded: 4, denied: 1 });
    expect(receipt.integrity.ok).toBe(true);
  });
});
