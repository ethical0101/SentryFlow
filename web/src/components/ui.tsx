import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import type { ApprovalStatus, Decision, ExecutionStatus, Risk } from "../types";
import { approvalLabel, decisionLabel, execLabel } from "../lib/format";

type Tone = "neutral" | "allow" | "amber" | "deny" | "info" | "muted";

export function Badge({ tone = "neutral", children, title, icon }: { tone?: Tone; children: ReactNode; title?: string; icon?: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

const decisionTone: Record<Decision, Tone> = { ALLOW: "allow", REQUIRE_APPROVAL: "amber", DENY: "deny" };
export function DecisionBadge({ decision }: { decision: Decision }) {
  return <Badge tone={decisionTone[decision]}>{decisionLabel[decision]}</Badge>;
}

const execTone: Record<ExecutionStatus, Tone> = { NOT_STARTED: "muted", BLOCKED: "amber", RUNNING: "info", SUCCEEDED: "allow", FAILED: "deny", SKIPPED: "muted" };
export function ExecBadge({ status }: { status: ExecutionStatus }) {
  return <Badge tone={execTone[status]}>{execLabel[status]}</Badge>;
}

const approvalTone: Record<ApprovalStatus, Tone> = { NOT_REQUIRED: "muted", PENDING: "amber", APPROVED: "allow", REJECTED: "deny", EXPIRED: "muted", INVALIDATED: "deny", NOT_APPLICABLE: "muted" };
export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  if (status === "NOT_REQUIRED" || status === "NOT_APPLICABLE") return null;
  return <Badge tone={approvalTone[status]}>Approval: {approvalLabel[status]}</Badge>;
}

const riskTone: Record<Risk, Tone> = { LOW: "muted", MEDIUM: "neutral", HIGH: "amber", CRITICAL: "deny" };
export function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <Badge tone={riskTone[risk]} title="Risk is assigned by the policy rule, never by the model">
      {risk.toLowerCase()} risk
    </Badge>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "amber";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
};
export function Button({ variant = "secondary", size = "md", loading, icon, children, className = "", disabled, ...rest }: ButtonProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="spin" size={size === "sm" ? 14 : 16} aria-hidden /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, className = "", id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="spinner-row" role="status">
      <Loader2 className="spin" size={16} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`${label}: ${value.slice(0, 16)}`}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard may be blocked */
        }
      }}
    >
      {done ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

export function HashText({ value, n = 12 }: { value: string | undefined; n?: number }) {
  if (!value) return <span className="mono muted">—</span>;
  return (
    <span className="hash">
      <code className="mono" title={value}>
        {value.slice(0, n)}…
      </code>
      <CopyButton value={value} label="Copy hash" />
    </span>
  );
}

export function JsonBlock({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json" style={maxHeight ? { maxHeight } : undefined}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Side sheet with Esc-to-close and focus management. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header className="drawer-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} disabled={disabled}>
      <span className="switch-knob" />
    </button>
  );
}
