import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadDevCredentials, SentryMcpClient, ToolError, type Credentials, type TrafficEntry } from "./mcp/client";
import type { Action, AuditRecord, Health, Household, Integrity, PendingApproval, Plan, PolicyEvaluation, PolicyInfo, Receipt } from "./types";

export type ConnectionState =
  | { phase: "connecting" }
  | { phase: "needs-credentials"; reason: string }
  | { phase: "error"; message: string }
  | { phase: "ready" };

export interface Toast {
  id: number;
  tone: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
}

export interface Turn {
  planId: string;
  request: string;
  reply: string;
  at: string;
}

interface Ctx {
  connection: ConnectionState;
  agent: SentryMcpClient | null;
  approver: SentryMcpClient | null;
  health: Health | null;
  plans: Plan[];
  household: Household | null;
  pending: PendingApproval[];
  policy: PolicyInfo | null;
  traffic: TrafficEntry[];
  turns: Turn[];
  toasts: Toast[];
  busy: Record<string, boolean>;
  selectedPlanId: string | null;
  selectPlan: (id: string | null) => void;
  dismissToast: (id: number) => void;
  notify: (t: Omit<Toast, "id">) => void;
  connectWith: (c: Credentials) => void;
  refresh: () => Promise<void>;
  planRequest: (request: string, planner: "auto" | "rules") => Promise<Plan | null>;
  executePlan: (planId: string) => Promise<void>;
  executeAction: (planId: string, actionId: string) => Promise<void>;
  resolveApproval: (planId: string, actionId: string, argsHash: string, decision: "approve" | "reject", note?: string) => Promise<boolean>;
  requestApproval: (planId: string, actionId: string) => Promise<void>;
  updateAction: (planId: string, actionId: string, args: Record<string, unknown>) => Promise<boolean>;
  evaluate: (tool: string, args: Record<string, unknown>, planId?: string) => Promise<(PolicyEvaluation & { validation: { ok: boolean; errors: string[] }; argsHash: string }) | null>;
  resetEnvironment: (clearPlans: boolean) => Promise<void>;
  setFault: (deviceId: string, offline: boolean) => Promise<void>;
  getReceipt: (planId: string) => Promise<Receipt | null>;
  getAudit: (planId?: string) => Promise<{ records: AuditRecord[]; integrity: Integrity } | null>;
}

const SentryContext = createContext<Ctx | null>(null);

export function useSentry(): Ctx {
  const ctx = useContext(SentryContext);
  if (!ctx) throw new Error("useSentry outside provider");
  return ctx;
}

const CRED_KEY = "sentryflow.credentials";

export function SentryProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>({ phase: "connecting" });
  const [agent, setAgent] = useState<SentryMcpClient | null>(null);
  const [approver, setApprover] = useState<SentryMcpClient | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [household, setHousehold] = useState<Household | null>(null);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const [traffic, setTraffic] = useState<TrafficEntry[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [selectedPlanId, selectPlan] = useState<string | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const toastSeq = useRef(0);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastSeq.current;
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 9000 : 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), []);

  const onTraffic = useCallback((e: TrafficEntry) => setTraffic((xs) => [...xs.slice(-299), e]), []);

  // ── Bootstrap credentials (local dev endpoint, else session storage, else ask) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dev = await loadDevCredentials();
      if (cancelled) return;
      if (dev) return setCreds(dev);
      try {
        const saved = sessionStorage.getItem(CRED_KEY);
        if (saved) return setCreds(JSON.parse(saved) as Credentials);
      } catch {
        /* storage unavailable */
      }
      setConnection({ phase: "needs-credentials", reason: "The server does not expose development credentials. Paste the agent and approver tokens." });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connectWith = useCallback((c: Credentials) => {
    try {
      sessionStorage.setItem(CRED_KEY, JSON.stringify(c));
    } catch {
      /* ignore */
    }
    setConnection({ phase: "connecting" });
    setCreds(c);
  }, []);

  // ── Open both MCP sessions ──
  useEffect(() => {
    if (!creds) return;
    let disposed = false;
    const a = new SentryMcpClient("agent", creds.agentToken, onTraffic);
    const o = new SentryMcpClient("approver", creds.approverToken, onTraffic);
    (async () => {
      try {
        await Promise.all([a.connect(), o.connect()]);
        if (disposed) return;
        setAgent(a);
        setApprover(o);
        setConnection({ phase: "ready" });
      } catch (e) {
        if (disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/401|Unauthorized/i.test(msg)) setConnection({ phase: "needs-credentials", reason: "The server rejected these credentials." });
        else setConnection({ phase: "error", message: `Could not connect to the SentryFlow MCP server: ${msg}` });
      }
    })();
    return () => {
      disposed = true;
      void a.close();
      void o.close();
    };
  }, [creds, onTraffic]);

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, opts: { quiet?: boolean } = {}): Promise<T | null> => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        return await fn();
      } catch (e) {
        if (!opts.quiet) {
          const code = e instanceof ToolError ? e.code : "ERROR";
          toast({ tone: code === "FORBIDDEN" || code === "POLICY_DENIED" ? "warn" : "error", title: code.replace(/_/g, " "), body: e instanceof Error ? e.message : String(e) });
        }
        return null;
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
    },
    [toast],
  );

  const refresh = useCallback(async () => {
    if (!agent || !approver) return;
    await run("refresh", async () => {
      const [p, h, q, hl] = await Promise.all([
        agent.call<{ plans: Plan[] }>("sentryflow_list_plans", { limit: 30 }),
        agent.call<{ household: Household }>("sentryflow_get_device_state"),
        approver.call<{ pending: PendingApproval[] }>("sentryflow_list_pending_approvals"),
        fetch("/health").then((r) => r.json() as Promise<Health>).catch(() => null),
      ]);
      setPlans(p.plans);
      selectPlan((cur) => (cur && p.plans.some((x) => x.planId === cur) ? cur : (p.plans[0]?.planId ?? null)));
      setHousehold(h.household);
      setPending(q.pending);
      if (hl) setHealth(hl);
    });
  }, [agent, approver, run]);

  useEffect(() => {
    if (connection.phase !== "ready" || !agent) return;
    void refresh();
    void run("policy", async () => setPolicy(await agent.call<PolicyInfo>("sentryflow_get_policy")), { quiet: true });
  }, [connection.phase, agent, refresh, run]);

  // Health is plain HTTP (not MCP) and cheap; keep it fresh for the status view.
  useEffect(() => {
    if (connection.phase !== "ready") return;
    const t = setInterval(() => {
      fetch("/health").then((r) => r.json() as Promise<Health>).then(setHealth).catch(() => undefined);
    }, 15000);
    return () => clearInterval(t);
  }, [connection.phase]);

  const upsertPlan = useCallback((plan: Plan) => {
    setPlans((ps) => [plan, ...ps.filter((p) => p.planId !== plan.planId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  // Actions depend only on stable inputs, so views can safely list them as effect dependencies.
  const actions = useMemo(
    (): Pick<Ctx, "planRequest" | "executePlan" | "executeAction" | "resolveApproval" | "requestApproval" | "updateAction" | "evaluate" | "resetEnvironment" | "setFault" | "getReceipt" | "getAudit"> => ({
      planRequest: async (request, planner) => {
        if (!agent) return null;
        const r = await run("plan", () => agent.call<{ plan: Plan; voiceSummary: string }>("sentryflow_plan_request", { request, planner }));
        if (!r) return null;
        upsertPlan(r.plan);
        selectPlan(r.plan.planId);
        setTurns((ts) => [...ts, { planId: r.plan.planId, request, reply: r.voiceSummary, at: new Date().toISOString() }]);
        await refresh();
        return r.plan;
      },
      executePlan: async (planId) => {
        if (!agent) return;
        const r = await run(`exec:${planId}`, () => agent.call<{ plan: Plan }>("sentryflow_execute_plan", { planId }));
        if (r) {
          upsertPlan(r.plan);
          toast({ tone: "info", title: "Plan executed", body: r._text });
        }
        await refresh();
      },
      executeAction: async (planId, actionId) => {
        if (!agent) return;
        const r = await run(`exec:${actionId}`, () => agent.call<{ action: Action }>("sentryflow_execute_action", { planId, actionId }));
        if (r) toast({ tone: r.action.execution.status === "SUCCEEDED" ? "success" : "warn", title: r.action.execution.status === "SUCCEEDED" ? "Executed" : "Not executed", body: r._text });
        await refresh();
      },
      resolveApproval: async (planId, actionId, argsHash, decision, note) => {
        if (!approver) return false;
        const r = await run(`approve:${actionId}`, () => approver.call<{ action: Action }>("sentryflow_resolve_approval", { planId, actionId, decision, argsHash, ...(note ? { note } : {}) }));
        if (r) toast({ tone: decision === "approve" ? "success" : "info", title: decision === "approve" ? "Approved" : "Rejected", body: r._text });
        await refresh();
        return !!r;
      },
      requestApproval: async (planId, actionId) => {
        if (!agent) return;
        const r = await run(`req:${actionId}`, () => agent.call("sentryflow_request_approval", { planId, actionId }));
        if (r) toast({ tone: "info", title: "Approval requested", body: r._text });
        await refresh();
      },
      updateAction: async (planId, actionId, args) => {
        if (!agent) return false;
        const r = await run(`edit:${actionId}`, () => agent.call<{ action: Action }>("sentryflow_update_action", { planId, actionId, args }));
        if (r) toast({ tone: "info", title: "Action updated", body: r._text });
        await refresh();
        return !!r;
      },
      evaluate: async (tool, args, planId) => {
        if (!agent) return null;
        const r = await run("evaluate", () => agent.call<{ evaluation: PolicyEvaluation & { validation: { ok: boolean; errors: string[] }; argsHash: string } }>("sentryflow_evaluate_action", { tool, args, ...(planId ? { planId } : {}) }));
        return r?.evaluation ?? null;
      },
      resetEnvironment: async (clearPlans) => {
        if (!approver) return;
        const r = await run("reset", () => approver.call("sentryflow_reset_environment", { clearPlans }));
        if (r) {
          toast({ tone: "info", title: "Simulation reset", body: clearPlans ? "Devices and plans were reset. The audit log is kept." : "Devices were reset. Plans and audit log are kept." });
          if (clearPlans) {
            selectPlan(null);
            setTurns([]);
          }
        }
        await refresh();
      },
      setFault: async (deviceId, offline) => {
        if (!approver) return;
        await run(`fault:${deviceId}`, () => approver.call("sentryflow_set_device_fault", { deviceId, offline }));
        await refresh();
      },
      getReceipt: async (planId) => {
        if (!agent) return null;
        const r = await run(`receipt:${planId}`, () => agent.call<{ receipt: Receipt }>("sentryflow_get_receipt", { planId }));
        return r?.receipt ?? null;
      },
      getAudit: async (planId) => {
        if (!approver) return null;
        return run("audit", () => approver.call<{ records: AuditRecord[]; integrity: Integrity }>("sentryflow_get_audit_log", { limit: 300, ...(planId ? { planId } : {}) }));
      },
    }),
    [agent, approver, run, refresh, toast, upsertPlan],
  );

  const value = useMemo<Ctx>(
    () => ({
      connection,
      agent,
      approver,
      health,
      plans,
      household,
      pending,
      policy,
      traffic,
      turns,
      toasts,
      busy,
      selectedPlanId,
      selectPlan,
      dismissToast,
      notify: toast,
      connectWith,
      refresh,
      ...actions,
    }),
    [connection, agent, approver, health, plans, household, pending, policy, traffic, turns, toasts, busy, selectedPlanId, dismissToast, connectWith, refresh, toast, actions],
  );

  return <SentryContext.Provider value={value}>{children}</SentryContext.Provider>;
}
