import { z } from "zod";
import { hasDangerousKeys } from "../domain/safety.js";

/** A proposal as emitted by any planner. Everything here is untrusted until the service validates it. */
export interface Proposal {
  ref: string;
  tool: string;
  args: Record<string, unknown>;
  explanation: string;
  dependsOn: string[];
}

export const MAX_ACTIONS = 12;

// Lenient on shape (small models vary), strict on types. Unknown keys such as "approved",
// "risk" or "decision" are stripped: the model has no say in authorization.
const RawAction = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional().default({}),
  arguments: z.record(z.unknown()).optional(),
  explanation: z.string().optional().default(""),
  dependsOn: z.array(z.union([z.string(), z.number()])).optional().default([]),
});
const RawPlan = z.object({ actions: z.array(z.unknown()) });

const clean = (s: string, max: number) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export interface NormalizeResult {
  proposals: Proposal[];
  dropped: { reason: string; proposal: string }[];
}

/** Converts arbitrary JSON into proposals, dropping (and recording) anything malformed. */
export function normalizeProposals(raw: unknown): NormalizeResult {
  const plan = RawPlan.safeParse(raw);
  if (!plan.success) throw new Error("Planner output is not an object with an 'actions' array");

  const proposals: Proposal[] = [];
  const dropped: NormalizeResult["dropped"] = [];
  const refMap = new Map<string, string>();

  for (const [i, item] of plan.data.actions.entries()) {
    const preview = clean(JSON.stringify(item) ?? String(item), 160);
    if (proposals.length >= MAX_ACTIONS) {
      dropped.push({ reason: `More than ${MAX_ACTIONS} actions proposed`, proposal: preview });
      continue;
    }
    if (hasDangerousKeys(item)) {
      dropped.push({ reason: "Prototype-tampering key (__proto__/constructor/prototype) in action", proposal: preview });
      continue;
    }
    const parsed = RawAction.safeParse(item);
    if (!parsed.success) {
      dropped.push({ reason: `Malformed action: ${parsed.error.issues[0]?.message ?? "invalid"}`, proposal: preview });
      continue;
    }
    const a = parsed.data;
    const ref = `p${proposals.length + 1}`;
    const modelRef = a.id !== undefined ? String(a.id) : String(i + 1);
    // Dependencies may only point to earlier proposals: this makes cycles impossible.
    const deps = a.dependsOn.map(String).map((d) => refMap.get(d)).filter((d): d is string => !!d);
    refMap.set(modelRef, ref);
    proposals.push({
      ref,
      tool: clean(a.tool, 64),
      args: a.arguments ?? a.args,
      explanation: clean(a.explanation, 300),
      dependsOn: [...new Set(deps)],
    });
  }
  return { proposals, dropped };
}
