import { describe, expect, it } from "vitest";
import { initialHousehold } from "../src/environment/household.js";
import { evaluate, loadPolicy, type PolicyDocument } from "../src/policy/engine.js";
import type { UserConstraint } from "../src/domain/types.js";
import { defaultPolicy } from "./helpers.js";

const now = new Date("2026-10-10T12:00:00Z");
const state = initialHousehold(now);
const policy = defaultPolicy();
const ev = (tool: string, args: Record<string, unknown>, s: unknown = state, constraints: UserConstraint[] = []) =>
  evaluate(policy, { tool, args, state: s, constraints, now });

describe("policy engine — default household policy", () => {
  it.each([
    ["get_device_state", {}, "ALLOW", "read.device_state"],
    ["get_security_status", {}, "ALLOW", "read.security_status"],
    ["set_light", { lightId: "all", on: false }, "ALLOW", "lighting.any"],
    ["set_thermostat", { mode: "eco" }, "ALLOW", "climate.in_range"],
    ["set_thermostat", { mode: "heat", targetC: 22 }, "ALLOW", "climate.in_range"],
    ["set_thermostat", { mode: "heat", targetC: 12 }, "DENY", "climate.too_cold"],
    ["set_thermostat", { mode: "cool", targetC: 30 }, "DENY", "climate.too_hot"],
    ["set_thermostat", { mode: "off" }, "REQUIRE_APPROVAL", "climate.off"],
    ["lock_door", { doorId: "back_door" }, "ALLOW", "locks.lock"],
    ["unlock_door", { doorId: "front_door" }, "REQUIRE_APPROVAL", "locks.unlock"],
    ["set_security_mode", { mode: "armed_away" }, "ALLOW", "security.arm"],
    ["set_security_mode", { mode: "disarmed" }, "DENY", "security.disarm"],
    ["set_camera_recording", { cameraId: "backyard_cam", recording: false }, "DENY", "security.camera_off"],
    ["set_camera_recording", { cameraId: "backyard_cam", recording: true }, "ALLOW", "security.camera_on"],
    ["enable_routine", { routineId: "leaving_home" }, "ALLOW", "routines.preapproved"],
    ["enable_routine", { routineId: "vacation_mode" }, "REQUIRE_APPROVAL", "routines.other"],
    ["purchase_item", { sku: "air_filter", quantity: 2 }, "REQUIRE_APPROVAL", "purchase.approval"],
    ["purchase_item", { sku: "robot_vacuum", quantity: 1 }, "DENY", "purchase.over_limit"],
    ["purchase_item", { sku: "coffee_beans", quantity: 6 }, "DENY", "purchase.over_limit"],
  ])("%s %j → %s via %s", (tool, args, decision, ruleId) => {
    const r = ev(tool, args as Record<string, unknown>);
    expect(r.decision).toBe(decision);
    expect(r.ruleId).toBe(ruleId);
    expect(r.policyVersion).toBe(policy.version);
  });

  it("denies unknown tools", () => {
    const r = ev("open_garage_and_disable_alarm", {});
    expect(r).toMatchObject({ decision: "DENY", ruleId: "catalog.unknown_tool", risk: "CRITICAL" });
  });

  it("denies invalid arguments instead of guessing", () => {
    expect(ev("set_light", { lightId: "garage", on: true }).ruleId).toBe("schema.invalid_args");
    expect(ev("set_light", { lightId: "all", on: "yes" }).decision).toBe("DENY");
    expect(ev("unlock_door", { doorId: "front_door", approved: true }).ruleId).toBe("schema.invalid_args");
    expect(ev("purchase_item", { sku: "air_filter", quantity: 1, unitPriceUsd: 0.01 }).decision).toBe("DENY");
  });

  it("uses state conditions: unlocking while armed away is denied", () => {
    const armed = { ...state, security: { mode: "armed_away", changedAt: now.toISOString() } };
    const r = ev("unlock_door", { doorId: "front_door" }, armed);
    expect(r).toMatchObject({ decision: "DENY", ruleId: "locks.unlock_while_away" });
  });

  it("is deterministic", () => {
    const a = ev("purchase_item", { sku: "air_filter", quantity: 2 });
    const b = ev("purchase_item", { sku: "air_filter", quantity: 2 });
    expect(a).toEqual(b);
  });

  it("records a rule trace up to the first match", () => {
    const r = ev("set_thermostat", { mode: "eco" });
    expect(r.trace.map((t) => t.ruleId)).toEqual(["climate.too_cold", "climate.too_hot", "climate.off", "climate.in_range"]);
    expect(r.trace.at(-1)?.matched).toBe(true);
  });
});

describe("user constraints only tighten", () => {
  const requireApproval: UserConstraint = { id: "uc_1", categories: ["unlock", "security", "purchase"], effect: "REQUIRE_APPROVAL", sourceText: "never … without approval" };
  const deny: UserConstraint = { id: "uc_2", categories: ["purchase"], effect: "DENY", sourceText: "never buy anything" };

  it("can raise REQUIRE_APPROVAL to DENY", () => {
    const r = ev("purchase_item", { sku: "air_filter", quantity: 1 }, state, [deny]);
    expect(r.decision).toBe("DENY");
    expect(r.baseDecision).toBe("REQUIRE_APPROVAL");
    expect(r.constraintsApplied).toEqual(["uc_2"]);
  });

  it("never lowers a DENY", () => {
    const r = ev("set_security_mode", { mode: "disarmed" }, state, [requireApproval]);
    expect(r.decision).toBe("DENY");
    expect(r.constraintsApplied).toEqual([]);
  });

  it("does not affect unrelated tools", () => {
    expect(ev("set_light", { lightId: "all", on: false }, state, [requireApproval, deny]).decision).toBe("ALLOW");
    // Arming is not "disabling security".
    expect(ev("set_security_mode", { mode: "armed_away" }, state, [requireApproval]).decision).toBe("ALLOW");
  });
});

describe("policy loading", () => {
  const base = (): PolicyDocument => structuredClone(defaultPolicy().doc);

  it("rejects rules that reference unknown tools", () => {
    const doc = base();
    doc.rules.push({ id: "x", description: "", tool: "launch_rocket", decision: "ALLOW", risk: "LOW" });
    expect(() => loadPolicy(doc)).toThrow(/unknown tool/);
  });

  it("rejects duplicate rule ids and non-DENY defaults", () => {
    const dup = base();
    dup.rules.push({ ...dup.rules[0]! });
    expect(() => loadPolicy(dup)).toThrow(/Duplicate/);
    expect(() => loadPolicy({ ...base(), defaultDecision: "ALLOW" })).toThrow();
  });

  it("changes version when content changes", () => {
    const a = loadPolicy(base());
    const doc = base();
    doc.rules[0]!.description = "edited";
    expect(loadPolicy(doc).version).not.toBe(a.version);
  });

  it("falls back to default deny when no rule matches", () => {
    const doc = base();
    doc.rules = doc.rules.filter((r) => r.tool !== "lock_door");
    const r = evaluate(loadPolicy(doc), { tool: "lock_door", args: { doorId: "front_door" }, state, constraints: [], now });
    expect(r).toMatchObject({ decision: "DENY", ruleId: "default.deny" });
  });
});
