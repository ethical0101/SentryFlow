import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/audit.js";
import { executeTool, initialHousehold } from "../src/environment/household.js";
import { JsonStore } from "../src/store/store.js";

const now = new Date("2026-10-10T12:00:00Z");
const id = () => "000001";

describe("simulated household executors", () => {
  it("really changes state and returns before/after", () => {
    const s = initialHousehold(now);
    const { result } = executeTool(s, "set_light", { lightId: "all", on: false }, now, id);
    expect(Object.values(s.lights).every((l) => !l.on)).toBe(true);
    expect(result.changed).toHaveProperty("kitchen");
  });

  it("re-validates arguments (defense in depth)", () => {
    const s = initialHousehold(now);
    expect(() => executeTool(s, "unlock_door", { doorId: "garage" }, now, id)).toThrow(/Invalid|doorId/);
    expect(s.locks.front_door!.locked).toBe(true);
  });

  it("enforces hardware limits independent of policy", () => {
    const s = initialHousehold(now);
    expect(() => executeTool(s, "set_thermostat", { mode: "heat", targetC: 40 }, now, id)).toThrow(/hardware rejects/);
    expect(s.thermostat.targetC).toBe(21.5);
  });

  it("fails cleanly for an offline device", () => {
    const s = initialHousehold(now);
    s.faults.porch = "offline";
    expect(() => executeTool(s, "set_light", { lightId: "all", on: false }, now, id)).toThrow(/offline/);
    // No light was changed: the fault check happens before any mutation.
    expect(s.lights.kitchen!.on).toBe(true);
  });

  it("purchases are simulated and priced from the trusted catalog", () => {
    const s = initialHousehold(now);
    const { result } = executeTool(s, "purchase_item", { sku: "air_filter", quantity: 2 }, now, id);
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({ totalUsd: 68, simulated: true });
    expect(result.note).toMatch(/Simulated/);
  });
});

describe("audit hash chain", () => {
  const mk = () => {
    const log = new AuditLog(null);
    for (let i = 0; i < 5; i++) log.append({ type: "POLICY_EVALUATED", correlationId: "plan_x", actor: "t", data: { i }, ts: now });
    return log;
  };

  it("verifies an untouched chain", () => {
    expect(mk().verify()).toMatchObject({ ok: true, records: 5 });
  });

  it("detects an edited record on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-audit-"));
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(file);
    for (let i = 0; i < 4; i++) log.append({ type: "EXECUTION_SUCCEEDED", correlationId: "plan_x", actor: "t", data: { i }, ts: now });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const rec = JSON.parse(lines[1]!);
    rec.data.i = 999;
    lines[1] = JSON.stringify(rec);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(new AuditLog(file).verify()).toMatchObject({ ok: false, firstBrokenSeq: 2, problem: expect.stringContaining("hash") });
  });

  it("detects a deleted record and a corrupt line", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-audit-"));
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(file);
    for (let i = 0; i < 4; i++) log.append({ type: "EXECUTION_SUCCEEDED", correlationId: "plan_x", actor: "t", data: { i }, ts: now });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    expect(new AuditLog(file).verify().ok).toBe(false);
    writeFileSync(file, [lines[0], "{not json", lines[2]].join("\n") + "\n");
    expect(new AuditLog(file).verify()).toMatchObject({ ok: false, firstBrokenSeq: 2 });
  });

  it("persists across restarts and continues the chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-audit-"));
    const file = join(dir, "audit.jsonl");
    new AuditLog(file).append({ type: "SERVER_STARTED", correlationId: "system", actor: "t", ts: now });
    const again = new AuditLog(file);
    again.append({ type: "SERVER_STARTED", correlationId: "system", actor: "t", ts: now });
    expect(again.verify()).toMatchObject({ ok: true, records: 2 });
  });
});

describe("JSON store", () => {
  it("persists atomically and reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-store-"));
    const file = join(dir, "state.json");
    const a = new JsonStore<{ n: number }>(file, () => ({ n: 0 }));
    await a.update((d) => {
      d.n = 5;
    });
    expect(new JsonStore<{ n: number }>(file, () => ({ n: 0 })).snapshot().n).toBe(5);
  });

  it("discards changes when an update throws", async () => {
    const a = new JsonStore<{ n: number }>(null, () => ({ n: 1 }));
    await expect(
      a.update((d) => {
        d.n = 99;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(a.snapshot().n).toBe(1);
  });

  it("serialises concurrent updates", async () => {
    const a = new JsonStore<{ n: number }>(null, () => ({ n: 0 }));
    await Promise.all(Array.from({ length: 50 }, () => a.update(async (d) => {
      const v = d.n;
      await new Promise((r) => setTimeout(r, 0));
      d.n = v + 1;
    })));
    expect(a.snapshot().n).toBe(50);
  });
});
