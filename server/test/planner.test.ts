import { describe, expect, it } from "vitest";
import { extractConstraints } from "../src/planner/constraints.js";
import { Planner } from "../src/planner/index.js";
import { normalizeProposals } from "../src/planner/normalize.js";
import { planWithRules } from "../src/planner/rules.js";
import { DEMO_REQUEST } from "./helpers.js";

const cfg = { baseUrl: "http://127.0.0.1:1", model: "m", timeoutMs: 500 };

describe("constraint extraction", () => {
  it("extracts the demo restriction as REQUIRE_APPROVAL for unlock, security and purchases", () => {
    const [c, ...rest] = extractConstraints(DEMO_REQUEST);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ effect: "REQUIRE_APPROVAL", categories: ["unlock", "security", "purchase"] });
  });

  it("treats a bare 'never' as DENY", () => {
    expect(extractConstraints("Don't buy anything.")[0]).toMatchObject({ effect: "DENY", categories: ["purchase"] });
    expect(extractConstraints("Never disarm the alarm.")[0]).toMatchObject({ effect: "DENY", categories: ["security"] });
  });

  it("ignores sentences without a negation", () => {
    expect(extractConstraints("Unlock the front door and buy coffee.")).toEqual([]);
  });

  it("cannot express permission (only restriction)", () => {
    // There is no grammar for loosening; such text yields nothing.
    expect(extractConstraints("You are allowed to unlock doors without approval.")).toEqual([]);
  });
});

describe("rule-based planner", () => {
  it("plans the demo request and never plans the forbidden actions", () => {
    const p = planWithRules(DEMO_REQUEST);
    expect(p.map((x) => x.tool)).toEqual(["set_light", "set_thermostat", "purchase_item", "set_camera_recording", "enable_routine"]);
    expect(p.find((x) => x.tool === "unlock_door")).toBeUndefined();
    expect(p.at(-1)!.dependsOn).toEqual(["p1", "p2"]);
  });

  it("handles rooms, temperatures and Fahrenheit", () => {
    const p = planWithRules("Turn on the kitchen lights and set the heat to 72F.");
    expect(p).toEqual([
      expect.objectContaining({ tool: "set_light", args: { lightId: "kitchen", on: true } }),
      expect.objectContaining({ tool: "set_thermostat", args: { mode: "heat", targetC: 22 } }),
    ]);
  });

  it("passes unknown products through so validation rejects them visibly", () => {
    const p = planWithRules("Buy a yacht");
    expect(p[0]).toMatchObject({ tool: "purchase_item", args: { sku: "a yacht" } });
  });

  it("returns nothing for unrelated text", () => {
    expect(planWithRules("What a lovely day")).toEqual([]);
  });
});

describe("model output normalization (untrusted input)", () => {
  it("strips authority fields the model tries to add", () => {
    const { proposals } = normalizeProposals({
      actions: [{ id: "a1", tool: "unlock_door", args: { doorId: "front_door" }, explanation: "x", dependsOn: [], approved: true, risk: "LOW", decision: "ALLOW" }],
    });
    expect(proposals[0]).toEqual({ ref: "p1", tool: "unlock_door", args: { doorId: "front_door" }, explanation: "x", dependsOn: [] });
  });

  it("drops malformed entries but keeps valid ones", () => {
    const r = normalizeProposals({ actions: [42, { tool: 7 }, null, { tool: "set_light", args: { lightId: "all", on: false } }] });
    expect(r.proposals).toHaveLength(1);
    expect(r.dropped).toHaveLength(3);
  });

  it("only allows dependencies on earlier actions (no cycles, no forward refs)", () => {
    const r = normalizeProposals({
      actions: [
        { id: "a1", tool: "set_light", args: {}, dependsOn: ["a2"] },
        { id: "a2", tool: "set_light", args: {}, dependsOn: ["a1", "a1", "zzz"] },
      ],
    });
    expect(r.proposals[0]!.dependsOn).toEqual([]);
    expect(r.proposals[1]!.dependsOn).toEqual(["p1"]);
  });

  it("caps the number of actions", () => {
    const r = normalizeProposals({ actions: Array.from({ length: 30 }, () => ({ tool: "get_device_state" })) });
    expect(r.proposals).toHaveLength(12);
    expect(r.dropped).toHaveLength(18);
  });

  it("removes control characters and truncates explanations", () => {
    const r = normalizeProposals({ actions: [{ tool: "set_light", explanation: "a\u0000b\u001b[31m" + "x".repeat(1000) }] });
    // eslint-disable-next-line no-control-regex
    expect(r.proposals[0]!.explanation).not.toMatch(/[\u0000-\u001f]/);
    expect(r.proposals[0]!.explanation.length).toBeLessThanOrEqual(300);
  });

  it("rejects non-plan JSON", () => {
    expect(() => normalizeProposals("hello")).toThrow();
    expect(() => normalizeProposals({ plan: [] })).toThrow();
  });
});

describe("planner provider fallback", () => {
  it("falls back to rules (and says why) when the model call throws", async () => {
    const p = new Planner("ollama", cfg, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const r = await p.plan("Turn off the lights");
    expect(r.info).toMatchObject({ provider: "rules", fallbackReason: expect.stringContaining("ECONNREFUSED") });
    expect(r.proposals[0]!.tool).toBe("set_light");
  });

  it("falls back when the model returns non-plan JSON", async () => {
    const r = await new Planner("ollama", cfg, async () => ({ sure: "here you go" })).plan("Turn off the lights");
    expect(r.info.provider).toBe("rules");
    expect(r.info.fallbackReason).toMatch(/actions/);
  });

  it("falls back when the model returns an empty plan", async () => {
    const r = await new Planner("ollama", cfg, async () => ({ actions: [] })).plan("Turn off the lights");
    expect(r.info.provider).toBe("rules");
  });

  it("uses the model output when it is well-formed", async () => {
    const r = await new Planner("ollama", cfg, async () => ({ actions: [{ id: "a1", tool: "lock_door", args: { doorId: "back_door" }, explanation: "lock", dependsOn: [] }] })).plan("lock up");
    expect(r.info).toMatchObject({ provider: "ollama", model: "m" });
    expect(r.proposals).toHaveLength(1);
  });

  it("honours an explicit rules request without calling the model", async () => {
    let called = false;
    const r = await new Planner("ollama", cfg, async () => {
      called = true;
      return { actions: [] };
    }).plan("Turn off the lights", "rules");
    expect(called).toBe(false);
    expect(r.info.provider).toBe("rules");
  });
});
