import { useState } from "react";
import { CheckCircle2, CircleSlash, FlaskConical } from "lucide-react";
import { useSentry } from "../state";
import { Badge, Button, Card, DecisionBadge, HashText, KV, RiskBadge, Spinner } from "../components/ui";
import { conditionText } from "../lib/format";
import type { PolicyEvaluation } from "../types";

const TEMPLATES: Record<string, Record<string, unknown>> = {
  get_device_state: {},
  get_security_status: {},
  set_light: { lightId: "living_room", on: true, brightness: 60 },
  set_thermostat: { mode: "heat", targetC: 22 },
  lock_door: { doorId: "front_door" },
  unlock_door: { doorId: "front_door" },
  set_security_mode: { mode: "armed_away" },
  set_camera_recording: { cameraId: "backyard_cam", recording: false },
  enable_routine: { routineId: "vacation_mode" },
  purchase_item: { sku: "coffee_beans", quantity: 2 },
};

export function Policy() {
  const s = useSentry();
  const [tool, setTool] = useState("unlock_door");
  const [args, setArgs] = useState(JSON.stringify(TEMPLATES.unlock_door, null, 2));
  const [planId, setPlanId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<(PolicyEvaluation & { validation: { ok: boolean; errors: string[] }; argsHash: string }) | null>(null);

  if (!s.policy) return <Spinner label="Loading policy over MCP…" />;
  const { policy } = s;

  const evaluate = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return setErr("Arguments are not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return setErr("Arguments must be a JSON object.");
    setErr(null);
    setResult(await s.evaluate(tool, parsed as Record<string, unknown>, planId || undefined));
  };

  return (
    <div className="grid-2" style={{ alignItems: "start", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
      <Card
        title="Active policy"
        subtitle={policy.policy.description}
        actions={
          <>
            <Badge tone="info">v{policy.version}</Badge>
            <Badge tone="deny">default: deny</Badge>
          </>
        }
      >
        <p className="hint" style={{ marginBottom: 10 }}>
          Rules are evaluated top to bottom; the first rule whose tool and conditions match decides. The version includes a hash of the file, so any edit changes it and
          invalidates outstanding approvals. Approvals are valid for {policy.approvalTtlSeconds} s.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Rule</th>
                <th>When</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {policy.policy.rules.map((r, i) => (
                <tr key={r.id} className={result?.ruleId === r.id ? "hl" : ""}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <code>{r.id}</code>
                    <div className="hint">{r.description}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <div>{r.tool}</div>
                    {(r.when?.all ?? []).map((c, j) => (
                      <div key={j} className="muted">
                        {conditionText(c)}
                      </div>
                    ))}
                    {(r.when?.any ?? []).length > 0 && <div className="muted">any of: {(r.when?.any ?? []).map(conditionText).join(" | ")}</div>}
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 4 }}>
                      <DecisionBadge decision={r.decision} />
                      <RiskBadge risk={r.risk} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="muted">—</td>
                <td>
                  <code>default.deny</code>
                  <div className="hint">Nothing matched</div>
                </td>
                <td className="mono muted">*</td>
                <td>
                  <DecisionBadge decision="DENY" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="stack" style={{ gap: 18 }}>
        <Card title="Dry-run evaluator" subtitle="Ask the policy engine about any tool call against the current simulated state. Nothing executes.">
          <div className="stack">
            <div className="grid-2" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="ev-tool">
                  Tool
                </label>
                <select
                  id="ev-tool"
                  className="select"
                  value={tool}
                  onChange={(e) => {
                    setTool(e.target.value);
                    setArgs(JSON.stringify(TEMPLATES[e.target.value] ?? {}, null, 2));
                    setResult(null);
                  }}
                >
                  {policy.tools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="ev-plan">
                  Apply constraints from plan
                </label>
                <select id="ev-plan" className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">None</option>
                  {s.plans
                    .filter((p) => p.constraints.length > 0)
                    .map((p) => (
                      <option key={p.planId} value={p.planId}>
                        {p.request.slice(0, 50)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="ev-args">
                Arguments (JSON)
              </label>
              <textarea id="ev-args" className="textarea mono" rows={5} value={args} onChange={(e) => setArgs(e.target.value)} />
            </div>
            {err && <div className="action-note bad">{err}</div>}
            <div>
              <Button variant="primary" icon={<FlaskConical size={15} />} onClick={evaluate} loading={s.busy.evaluate}>
                Evaluate
              </Button>
            </div>
          </div>
        </Card>

        {result && (
          <Card title="Result" actions={<DecisionBadge decision={result.decision} />}>
            <div className="stack">
              <KV
                items={[
                  ["Matched rule", <code key="r">{result.ruleId}</code>],
                  ["Reason", result.reason],
                  ["Risk", <RiskBadge key="k" risk={result.risk} />],
                  ["Base decision", <DecisionBadge key="b" decision={result.baseDecision} />],
                  ["Constraints applied", result.constraintsApplied.join(", ") || "none"],
                  ["Validation", result.validation.ok ? "valid" : result.validation.errors.join("; ")],
                  ["Args hash", <HashText key="h" value={result.argsHash} n={16} />],
                  ["Policy version", <code key="v">{result.policyVersion}</code>],
                ]}
              />
              {result.trace.length > 0 && (
                <div>
                  <div className="section-label">Trace</div>
                  <div className="trace">
                    {result.trace.map((t) => (
                      <div key={t.ruleId} className={`trace-row ${t.matched ? "hit" : ""}`}>
                        {t.matched ? <CheckCircle2 size={13} color="var(--amber)" /> : <CircleSlash size={13} />} {t.ruleId}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        <Card title="Tool catalog" subtitle="The only operations the simulated household supports">
          <div className="stack" style={{ gap: 8 }}>
            {policy.tools.map((t) => (
              <div key={t.name} className="row between" style={{ alignItems: "flex-start" }}>
                <div>
                  <code>{t.name}</code>
                  <div className="hint">{t.description}</div>
                </div>
                <div className="row">
                  {t.readOnly ? <Badge tone="muted">read-only</Badge> : null}
                  {t.categories.map((c) => (
                    <Badge key={c} tone="neutral">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
