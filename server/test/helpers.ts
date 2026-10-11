import { resolve } from "node:path";
import { AuditLog } from "../src/audit/audit.js";
import type { Principal } from "../src/domain/types.js";
import { Planner, type ModelCall } from "../src/planner/index.js";
import { loadPolicyFile, type LoadedPolicy } from "../src/policy/engine.js";
import { initialAppState, SentryFlowService, type AppState } from "../src/service/sentryflow.js";
import { JsonStore } from "../src/store/store.js";

export const POLICY_PATH = resolve(import.meta.dirname, "../policy/default-policy.json");
export const defaultPolicy = (): LoadedPolicy => loadPolicyFile(POLICY_PATH);

export const AGENT: Principal = { role: "agent", id: "agent" };
export const OWNER: Principal = { role: "approver", id: "owner" };

export class FakeClock {
  t = new Date("2026-10-10T12:00:00.000Z").getTime();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeService(opts: { modelCall?: ModelCall; provider?: "ollama" | "rules"; ttlMs?: number; policy?: LoadedPolicy } = {}) {
  const clock = new FakeClock();
  let n = 0;
  const id = () => (++n).toString(16).padStart(8, "0") + "abcd";
  const store = new JsonStore<AppState>(null, () => initialAppState(clock.now()));
  const audit = new AuditLog(null);
  const planner = new Planner(opts.provider ?? (opts.modelCall ? "ollama" : "rules"), { baseUrl: "http://127.0.0.1:1", model: "test-model", timeoutMs: 1000 }, opts.modelCall);
  const svc = new SentryFlowService({ store, audit, planner, policy: opts.policy ?? defaultPolicy(), approvalTtlMs: opts.ttlMs ?? 300_000, now: clock.now, id });
  return { svc, clock, store, audit };
}

/** A model stub that returns a fixed plan. */
export const modelReturning = (actions: unknown[]): ModelCall => async () => ({ actions });

export const DEMO_REQUEST =
  "I'm leaving for college. Turn off the lights, set the thermostat to eco mode, and prepare the house. " +
  "Order 2 air filters and turn off the backyard camera. Never unlock a door, disable security, or make purchases without explicit approval.";
