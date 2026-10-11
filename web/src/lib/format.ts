import type { ApprovalStatus, Decision, ExecutionStatus } from "../types";

const pretty = (s: unknown) => String(s).replace(/_/g, " ");

/** Short, human description of a tool call. Mirrors the server's voice phrasing. */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "set_light":
      return `Turn ${args.lightId === "all" ? "all lights" : `${pretty(args.lightId)} light`} ${args.on ? "on" : "off"}${typeof args.brightness === "number" ? ` (${args.brightness}%)` : ""}`;
    case "set_thermostat":
      return `Thermostat → ${pretty(args.mode)}${args.targetC !== undefined ? ` at ${String(args.targetC)} °C` : ""}`;
    case "lock_door":
      return `Lock ${pretty(args.doorId)}`;
    case "unlock_door":
      return `Unlock ${pretty(args.doorId)}`;
    case "set_security_mode":
      return args.mode === "disarmed" ? "Disarm security system" : `Arm security (${pretty(args.mode)})`;
    case "set_camera_recording":
      return `${args.recording ? "Start" : "Stop"} recording · ${pretty(args.cameraId).replace(" cam", " camera")}`;
    case "enable_routine":
      return `Enable routine · ${pretty(args.routineId)}`;
    case "purchase_item":
      return `Order ${String(args.quantity ?? "?")} × ${pretty(args.sku)}`;
    case "get_device_state":
      return "Read device state";
    case "get_security_status":
      return "Read security status";
    default:
      return pretty(tool);
  }
}

export const decisionLabel: Record<Decision, string> = { ALLOW: "Allowed", REQUIRE_APPROVAL: "Needs approval", DENY: "Denied" };

export const execLabel: Record<ExecutionStatus, string> = {
  NOT_STARTED: "Not run",
  BLOCKED: "Blocked",
  RUNNING: "Running",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

export const approvalLabel: Record<ApprovalStatus, string> = {
  NOT_REQUIRED: "Not required",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  INVALIDATED: "Invalidated",
  NOT_APPLICABLE: "—",
};

export function shortHash(h: string | undefined, n = 10) {
  return h ? `${h.slice(0, n)}…` : "—";
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clock(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

export function countdown(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function conditionText(c: { fact: string; op: string; value?: unknown }): string {
  const ops: Record<string, string> = { eq: "=", neq: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥", in: "∈", nin: "∉", exists: "exists" };
  return c.op === "exists" ? `${c.fact} exists` : `${c.fact} ${ops[c.op] ?? c.op} ${JSON.stringify(c.value)}`;
}

export function titleCase(s: string) {
  return pretty(s).replace(/\b\w/g, (m) => m.toUpperCase());
}
