import { resolve } from "node:path";
import { AuditLog } from "./audit/audit.js";
import type { Config } from "./config.js";
import { Planner } from "./planner/index.js";
import { loadPolicyFile } from "./policy/engine.js";
import { initialAppState, SentryFlowService, type AppState } from "./service/sentryflow.js";
import { JsonStore } from "./store/store.js";

export async function buildService(cfg: Config): Promise<SentryFlowService> {
  const policy = loadPolicyFile(cfg.policyFile);
  const store = new JsonStore<AppState>(resolve(cfg.dataDir, "state.json"), () => initialAppState(new Date()), (raw) => {
    const s = raw as AppState;
    if (!s || s.version !== 1 || !s.household || !s.plans) throw new Error("state.json is not a SentryFlow v1 state file; move it aside to start fresh");
    return s;
  });
  const audit = new AuditLog(resolve(cfg.dataDir, "audit.jsonl"));
  const planner = new Planner(cfg.planner, cfg.ollama);
  const svc = new SentryFlowService({ store, audit, planner, policy, approvalTtlMs: cfg.approvalTtlSeconds * 1000 });
  await svc.recover();
  return svc;
}
