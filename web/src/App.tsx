import { useCallback, useEffect, useState } from "react";
import { Activity, FileText, Home, KeyRound, LayoutDashboard, Loader2, Scale, Shield, ShieldAlert, X } from "lucide-react";
import { useSentry } from "./state";
import { Workspace } from "./views/Workspace";
import { Approvals } from "./views/Approvals";
import { Policy } from "./views/Policy";
import { Environment } from "./views/Environment";
import { Audit } from "./views/Audit";
import { System } from "./views/System";
import { Button } from "./components/ui";

const PAGES = {
  workspace: { nav: "Workspace", title: "Agent workspace", sub: "Plan, review and run household requests", icon: LayoutDashboard },
  approvals: { nav: "Approvals", title: "Approval queue", sub: "Owner decisions on sensitive actions", icon: ShieldAlert },
  environment: { nav: "Environment", title: "Simulated environment", sub: "Live state of the simulated household", icon: Home },
  audit: { nav: "Receipts & audit", title: "Receipts & audit", sub: "What happened, who decided, and proof it was recorded", icon: FileText },
  policy: { nav: "Policy", title: "Policy inspector", sub: "Deterministic rules that decide every action", icon: Scale },
  system: { nav: "System & MCP", title: "System & MCP", sub: "Server health, sessions, tools and live protocol traffic", icon: Activity },
} as const;
type Page = keyof typeof PAGES;

function parseHash(): { page: Page; arg?: string } {
  const [p, arg] = window.location.hash.replace(/^#\/?/, "").split(":");
  return { page: (p && p in PAGES ? p : "workspace") as Page, arg };
}

export function App() {
  const s = useSentry();
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((target: string) => {
    window.location.hash = `/${target}`;
  }, []);

  if (s.connection.phase !== "ready") return <ConnectionScreen />;

  const page = PAGES[route.page];
  const nav = (key: Page) => {
    const P = PAGES[key];
    const Icon = P.icon;
    return (
      <button key={key} className="nav-item" aria-current={route.page === key ? "page" : undefined} onClick={() => go(key)}>
        <Icon size={16} aria-hidden />
        {P.nav}
        {key === "approvals" && s.pending.length > 0 && <span className="count" aria-label={`${s.pending.length} pending`}>{s.pending.length}</span>}
      </button>
    );
  };

  const ok = s.health?.status === "ok";
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Shield size={16} />
          </div>
          <div>
            <div className="brand-name">SentryFlow</div>
            <div className="brand-sub">Permission-aware agent execution</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <div className="nav-section">Operate</div>
          {nav("workspace")}
          {nav("approvals")}
          {nav("environment")}
          <div className="nav-section">Inspect</div>
          {nav("audit")}
          {nav("policy")}
          {nav("system")}
        </nav>
        <div className="sidebar-foot">
          <span className="row">
            <span className={`dot ${ok ? "ok" : "bad"}`} /> MCP {s.health?.mcp.protocolVersion ?? ""}
          </span>
          <span className="row">
            <span className={`dot ${s.health?.planner.effective === "ollama" ? "ok" : "warn"}`} /> Planner: {s.health?.planner.effective === "ollama" ? s.health.planner.model : "rules fallback"}
          </span>
          <span className="row">
            <span className={`dot ${s.health?.audit.ok ? "ok" : "bad"}`} /> Audit chain {s.health?.audit.ok ? "verified" : "check"}
          </span>
        </div>
      </aside>
      <main className="main" id="main">
        <header className="topbar">
          <div>
            <h1>{page.title}</h1>
            <div className="sub">{page.sub}</div>
          </div>
          <span className="spacer" />
          <span className="hint">Simulated devices · local only</span>
        </header>
        <div className="content">
          {route.page === "workspace" && <Workspace go={go} />}
          {route.page === "approvals" && <Approvals />}
          {route.page === "environment" && <Environment />}
          {route.page === "audit" && <Audit planId={route.arg} />}
          {route.page === "policy" && <Policy />}
          {route.page === "system" && <System />}
        </div>
      </main>
      <Toasts />
    </div>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useSentry();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
          <div className="toast-title">{t.title}</div>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
          {t.body && <div className="toast-body">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}

function ConnectionScreen() {
  const s = useSentry();
  const [agentToken, setAgent] = useState("");
  const [approverToken, setApprover] = useState("");
  const c = s.connection;
  return (
    <div className="center">
      <div className="card connect">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">
            <Shield size={16} />
          </div>
          <div>
            <div className="brand-name">SentryFlow</div>
            <div className="brand-sub">Connecting to the MCP server</div>
          </div>
        </div>
        {c.phase === "connecting" && (
          <div className="spinner-row" role="status">
            <Loader2 className="spin" size={16} /> Initializing agent and approver MCP sessions…
          </div>
        )}
        {c.phase === "error" && (
          <>
            <div className="callout red">
              <ShieldAlert size={15} />
              <span>{c.message}</span>
            </div>
            <p className="hint">
              Start the server with <code>npm run dev</code> (or <code>npm start</code>) and reload this page.
            </p>
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </>
        )}
        {c.phase === "needs-credentials" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              s.connectWith({ agentToken: agentToken.trim(), approverToken: approverToken.trim() });
            }}
          >
            <div className="callout amber">
              <KeyRound size={15} />
              <span>{c.reason}</span>
            </div>
            <div>
              <label className="label" htmlFor="tok-a">
                Agent token
              </label>
              <input id="tok-a" className="input mono" type="password" autoComplete="off" value={agentToken} onChange={(e) => setAgent(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="tok-o">
                Approver token
              </label>
              <input id="tok-o" className="input mono" type="password" autoComplete="off" value={approverToken} onChange={(e) => setApprover(e.target.value)} required />
            </div>
            <Button variant="primary" type="submit">
              Connect
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
