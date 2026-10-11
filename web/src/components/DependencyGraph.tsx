import type { Action, Plan } from "../types";
import { describeAction, execLabel } from "../lib/format";

const COLORS = { ALLOW: "var(--green)", REQUIRE_APPROVAL: "var(--amber)", DENY: "var(--red)" } as const;
const W = 184;
const H = 58;
const GX = 46;
const GY = 18;

/** Layered DAG layout: column = longest dependency chain to the node. Pure SVG, no library. */
export function DependencyGraph({ plan, onSelect }: { plan: Plan; onSelect: (a: Action) => void }) {
  const depth = new Map<string, number>();
  for (const a of plan.actions) {
    const d = Math.max(-1, ...a.dependsOn.map((x) => depth.get(x) ?? -1)) + 1;
    depth.set(a.actionId, d);
  }
  const cols: Action[][] = [];
  for (const a of plan.actions) (cols[depth.get(a.actionId)!] ??= []).push(a);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((a, ri) => pos.set(a.actionId, { x: 10 + ci * (W + GX), y: 10 + ri * (H + GY) })));
  const width = 20 + cols.length * W + (cols.length - 1) * GX;
  const height = 20 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;

  return (
    <div className="graph">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Action dependency graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {plan.actions.flatMap((a) =>
          a.dependsOn.map((d) => {
            const from = pos.get(d);
            const to = pos.get(a.actionId);
            if (!from || !to) return null;
            const x1 = from.x + W;
            const y1 = from.y + H / 2;
            const x2 = to.x - 2;
            const y2 = to.y + H / 2;
            const mx = (x1 + x2) / 2;
            return <path key={`${d}-${a.actionId}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrow)" />;
          }),
        )}
        {plan.actions.map((a) => {
          const p = pos.get(a.actionId)!;
          const label = a.validation.ok ? describeAction(a.tool, a.args) : a.tool;
          return (
            <g
              key={a.actionId}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${a.index + 1}. ${label}: ${a.policy.decision}, ${a.execution.status}`}
              onClick={() => onSelect(a)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(a)}
              style={{ cursor: "pointer" }}
            >
              <rect width={W} height={H} rx={9} fill="var(--surface-2)" stroke="var(--border-strong)" />
              <rect width={4} height={H} rx={2} fill={COLORS[a.policy.decision]} />
              <text x={14} y={22} fill="var(--text)" fontSize={12.5} fontWeight={600}>
                {a.index + 1}. {label.length > 23 ? label.slice(0, 22) + "…" : label}
              </text>
              <text x={14} y={42} fill="var(--text-3)" fontSize={11.5}>
                {a.policy.decision.replace("_", " ").toLowerCase()} · {execLabel[a.execution.status].toLowerCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
