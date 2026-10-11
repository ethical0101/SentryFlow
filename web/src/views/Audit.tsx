import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Link2, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { useSentry } from "../state";
import type { AuditRecord, Integrity, Receipt } from "../types";
import { Badge, Button, Card, DecisionBadge, Empty, ExecBadge, HashText, JsonBlock, Spinner } from "../components/ui";
import { clock, describeAction } from "../lib/format";

const tone = (type: string) =>
  /SUCCEEDED|GRANTED|CONSUMED/.test(type) ? "good" : /FAILED|REJECTED|INVALIDATED|DENIED|AUTHORIZATION|DUPLICATE/.test(type) ? "bad" : /BLOCKED|REQUESTED|EXPIRED|FALLBACK|SKIPPED|WITHDRAWN/.test(type) ? "warn" : "";

export function Audit({ planId: initialPlan }: { planId?: string }) {
  const s = useSentry();
  const [planId, setPlanId] = useState(initialPlan ?? s.selectedPlanId ?? s.plans[0]?.planId ?? "");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [log, setLog] = useState<{ records: AuditRecord[]; integrity: Integrity } | null>(null);
  const [scope, setScope] = useState<"plan" | "all">("plan");
  const [open, setOpen] = useState<number | null>(null);
  const { getReceipt, getAudit } = s;

  useEffect(() => {
    if (initialPlan) setPlanId(initialPlan);
  }, [initialPlan]);

  const load = useCallback(async () => {
    const [r, l] = await Promise.all([planId ? getReceipt(planId) : Promise.resolve(null), getAudit(scope === "plan" && planId ? planId : undefined)]);
    setReceipt(r);
    setLog(l);
  }, [planId, scope, getReceipt, getAudit]);

  useEffect(() => {
    void load();
  }, [load, s.plans]);

  const download = () => {
    if (!receipt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${receipt.receiptId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row between">
        <div className="row" style={{ flex: "1 1 280px" }}>
          <label className="label" htmlFor="audit-plan" style={{ margin: 0 }}>
            Plan
          </label>
          <select id="audit-plan" className="select" style={{ flex: "1 1 200px", maxWidth: 360 }} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {s.plans.length === 0 && <option value="">No plans yet</option>}
            {s.plans.map((p) => (
              <option key={p.planId} value={p.planId}>
                {clock(p.createdAt)} — {p.request.slice(0, 50)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          {log && <IntegrityBadge integrity={log.integrity} />}
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()} loading={s.busy.audit}>
            Refresh
          </Button>
        </div>
      </div>

      {receipt ? (
        <Card
          title={
            <span className="row">
              <FileText size={16} /> Execution receipt <code className="muted">{receipt.receiptId}</code>
            </span>
          }
          subtitle={`Generated ${clock(receipt.generatedAt)} · policy ${receipt.policyVersion} · planner ${receipt.planner.provider}${receipt.planner.model ? ` (${receipt.planner.model})` : ""}`}
          actions={
            <Button size="sm" icon={<Download size={14} />} onClick={download}>
              Download JSON
            </Button>
          }
        >
          <div className="stack">
            <p className="plan-request">“{receipt.request}”</p>
            <div className="row">
              <Badge tone="allow">{receipt.summary.succeeded} executed</Badge>
              <Badge tone="amber">{receipt.summary.pendingApproval} pending approval</Badge>
              <Badge tone="deny">{receipt.summary.denied} denied by policy</Badge>
              <Badge tone="muted">{receipt.summary.blocked} blocked</Badge>
              <Badge tone="muted">{receipt.summary.failed} failed</Badge>
              <Badge tone="muted">{receipt.summary.skipped} skipped</Badge>
              {receipt.constraints.map((c) => (
                <Badge key={c.id} tone="amber">
                  {c.summary}
                </Badge>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Policy</th>
                    <th>Approval</th>
                    <th>Outcome</th>
                    <th>Args hash</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.actions.map((a) => (
                    <tr key={a.actionId}>
                      <td>
                        {describeAction(a.tool, a.args)}
                        <div className="hint mono">{a.actionId}</div>
                      </td>
                      <td>
                        <DecisionBadge decision={a.decision} />
                        <div className="hint mono">{a.ruleId}</div>
                      </td>
                      <td>
                        {a.approval.status === "NOT_REQUIRED" || a.approval.status === "NOT_APPLICABLE" ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {a.approval.status.toLowerCase()}
                            {a.approval.decidedBy && <div className="hint">by {a.approval.decidedBy} {clock(a.approval.decidedAt)}</div>}
                            {a.approval.consumedAt && <div className="hint">used {clock(a.approval.consumedAt)}</div>}
                          </>
                        )}
                      </td>
                      <td>
                        <ExecBadge status={a.execution.status} />
                        <div className="hint">{a.execution.error ?? a.execution.blockedReason ?? (a.execution.finishedAt ? clock(a.execution.finishedAt) : "")}</div>
                      </td>
                      <td>
                        <HashText value={a.argsHash} n={8} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="section-label">Event timeline ({receipt.timeline.length})</div>
              <div className="timeline">
                {receipt.timeline.map((e) => (
                  <div key={e.seq} className={`tl ${tone(e.type)}`}>
                    <div className="tl-time">{clock(e.ts)}</div>
                    <div className="tl-rail" />
                    <div className="tl-body">
                      <strong>{e.type.replace(/_/g, " ").toLowerCase()}</strong> <span className="muted">· {e.actor}</span>
                      {e.actionId && <span className="muted mono"> · {e.actionId}</span>}
                      <span className="muted mono"> · #{e.seq} {e.hash.slice(0, 8)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      ) : planId ? (
        <Spinner label="Loading receipt…" />
      ) : (
        <Card>
          <Empty icon={<FileText size={26} />} title="No receipts yet">
            Plan something in the workspace; every plan gets a receipt.
          </Empty>
        </Card>
      )}

      <Card
        title="Audit log"
        subtitle="Append-only JSON Lines; each record carries the SHA-256 of the previous one. Tamper-evident, not tamper-proof: see the threat model."
        actions={
          <select className="select" style={{ width: 170 }} value={scope} onChange={(e) => setScope(e.target.value as "plan" | "all")} aria-label="Audit scope">
            <option value="plan">This plan</option>
            <option value="all">All events</option>
          </select>
        }
      >
        {!log ? (
          <Spinner label="Loading audit log…" />
        ) : log.records.length === 0 ? (
          <p className="hint">No records.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Correlation</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {log.records
                  .slice()
                  .reverse()
                  .flatMap((r) => [
                    <tr key={r.seq} className="clickable" onClick={() => setOpen(open === r.seq ? null : r.seq)} aria-expanded={open === r.seq}>
                      <td className="muted mono">{r.seq}</td>
                      <td className="mono">{clock(r.ts)}</td>
                      <td>
                        <Badge tone={tone(r.type) === "good" ? "allow" : tone(r.type) === "bad" ? "deny" : tone(r.type) === "warn" ? "amber" : "neutral"}>{r.type.toLowerCase().replace(/_/g, " ")}</Badge>
                      </td>
                      <td>{r.actor}</td>
                      <td className="mono muted" style={{ fontSize: 12 }}>
                        {r.correlationId}
                        {r.actionId ? ` / ${r.actionId}` : ""}
                      </td>
                      <td>
                        <span className="row" style={{ gap: 4 }}>
                          <Link2 size={12} className="muted" />
                          <code className="muted">{r.hash.slice(0, 10)}</code>
                        </span>
                      </td>
                    </tr>,
                    open === r.seq ? (
                      <tr key={`${r.seq}-d`}>
                        <td colSpan={6}>
                          <JsonBlock value={r} maxHeight={260} />
                        </td>
                      </tr>
                    ) : null,
                  ])}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function IntegrityBadge({ integrity }: { integrity: Integrity }) {
  return integrity.ok ? (
    <Badge tone="allow" icon={<ShieldCheck size={12} />} title={`Head ${integrity.headHash}`}>
      Chain verified · {integrity.records} records
    </Badge>
  ) : (
    <Badge tone="deny" icon={<ShieldX size={12} />} title={integrity.problem}>
      Chain broken at #{integrity.firstBrokenSeq}
    </Badge>
  );
}
