import { useMemo, useState } from "react";
import { Check, Inbox, KeyRound, ShieldAlert, X } from "lucide-react";
import { useSentry } from "../state";
import type { PendingApproval } from "../types";
import { Badge, Button, Card, Empty, HashText, JsonBlock, RiskBadge } from "../components/ui";
import { clock, describeAction, timeAgo } from "../lib/format";

export function Approvals() {
  const s = useSentry();
  const decided = useMemo(
    () =>
      s.plans
        .flatMap((p) =>
          p.actions.flatMap((a) =>
            a.approval.history
              .filter((h) => h.event === "APPROVED" || h.event === "REJECTED" || h.event === "INVALIDATED" || h.event === "EXPIRED" || h.event === "CONSUMED")
              .map((h) => ({ plan: p, action: a, h })),
          ),
        )
        .sort((x, y) => y.h.at.localeCompare(x.h.at))
        .slice(0, 25),
    [s.plans],
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="callout">
        <KeyRound size={15} />
        <span>
          Decisions here are sent over a separate <strong>approver</strong> MCP session ({s.approver?.sessionId?.slice(0, 8) ?? "—"}…). The agent session cannot call{" "}
          <code>sentryflow_resolve_approval</code>; if it tries, the server returns FORBIDDEN and records the attempt.
        </span>
      </div>

      <Card title={`Pending approvals (${s.pending.length})`} subtitle="Each approval is bound to the exact arguments shown, expires after use or timeout, and is re-checked before execution.">
        {s.pending.length === 0 ? (
          <Empty icon={<Inbox size={26} />} title="Nothing waiting for you">
            Sensitive actions (unlocking, purchases, unusual routines) appear here when an agent plans them.
          </Empty>
        ) : (
          <div className="stack">
            {s.pending.map((p) => (
              <ApprovalCard key={p.actionId} p={p} />
            ))}
          </div>
        )}
      </Card>

      <Card title="Decision history" subtitle="Most recent approval events across plans">
        {decided.length === 0 ? (
          <p className="hint">No decisions yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Action</th>
                  <th>By</th>
                  <th>Args hash</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {decided.map(({ plan, action, h }, i) => (
                  <tr key={`${action.actionId}-${i}`}>
                    <td className="mono">{clock(h.at)}</td>
                    <td>
                      <Badge tone={h.event === "APPROVED" || h.event === "CONSUMED" ? "allow" : h.event === "REJECTED" || h.event === "INVALIDATED" ? "deny" : "muted"}>{h.event.toLowerCase()}</Badge>
                    </td>
                    <td>
                      {describeAction(action.tool, action.args)}
                      <div className="hint">{plan.request.slice(0, 60)}</div>
                    </td>
                    <td>{h.by ?? "system"}</td>
                    <td>{h.argsHash ? <HashText value={h.argsHash} n={8} /> : "—"}</td>
                    <td className="dim">{h.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ApprovalCard({ p }: { p: PendingApproval }) {
  const s = useSentry();
  const [note, setNote] = useState("");
  const busy = s.busy[`approve:${p.actionId}`];
  return (
    <article className="approval-card" aria-label={`Approval: ${describeAction(p.tool, p.args)}`}>
      <div className="row between">
        <div className="row">
          <ShieldAlert size={18} color="var(--amber)" aria-hidden />
          <span className="approval-title">{describeAction(p.tool, p.args)}</span>
        </div>
        <div className="row">
          <RiskBadge risk={p.risk} />
          <Badge tone="muted">requested {timeAgo(p.requestedAt)}</Badge>
        </div>
      </div>
      <p className="dim" style={{ fontSize: 13 }}>
        From: “{p.request.length > 160 ? p.request.slice(0, 160) + "…" : p.request}”
      </p>
      <div className="grid-2" style={{ gap: 12 }}>
        <div>
          <div className="section-label">Why approval is needed</div>
          <p style={{ fontSize: 13 }}>
            <code>{p.ruleId}</code> — {p.reason}
          </p>
          <p className="hint" style={{ marginTop: 6 }}>
            Agent's explanation (untrusted): {p.explanation}
          </p>
        </div>
        <div>
          <div className="section-label">Exactly what will run</div>
          <JsonBlock value={{ tool: p.tool, args: p.args }} maxHeight={140} />
        </div>
      </div>
      <div className="bind">
        <span>
          Your decision is bound to this argument hash. If anyone changes the arguments, this approval stops working.
        </span>
        <HashText value={p.argsHash} n={24} />
      </div>
      <div className="row between">
        <input className="input" style={{ maxWidth: 360 }} placeholder="Optional note (recorded in the audit log)" value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
        <div className="row">
          <Button variant="danger" icon={<X size={15} />} onClick={() => void s.resolveApproval(p.planId, p.actionId, p.argsHash, "reject", note || undefined)} loading={busy}>
            Reject
          </Button>
          <Button variant="amber" icon={<Check size={15} />} onClick={() => void s.resolveApproval(p.planId, p.actionId, p.argsHash, "approve", note || undefined)} loading={busy}>
            Approve
          </Button>
        </div>
      </div>
    </article>
  );
}
