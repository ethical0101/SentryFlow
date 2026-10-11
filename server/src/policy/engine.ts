import { readFileSync } from "node:fs";
import { z } from "zod";
import { categoriesFor, derivedFacts, isToolName, RISK_ORDER, validateToolArgs, type RiskLevel } from "../domain/catalog.js";
import { canonicalJson, sha256 } from "../domain/canonical.js";
import { DECISION_ORDER, type Decision, type PolicyEvaluation, type RuleTrace, type UserConstraint } from "../domain/types.js";

const DecisionSchema = z.enum(["ALLOW", "REQUIRE_APPROVAL", "DENY"]);
const RiskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ConditionSchema = z
  .object({
    fact: z.string().regex(/^(args|state|derived)(\.[A-Za-z0-9_]+)+$/),
    op: z.enum(["eq", "neq", "in", "nin", "lt", "lte", "gt", "gte", "exists"]),
    value: z.unknown().optional(),
  })
  .strict();
export type Condition = z.infer<typeof ConditionSchema>;

const RuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    description: z.string().max(300),
    tool: z.string().min(1),
    when: z
      .object({ all: z.array(ConditionSchema).optional(), any: z.array(ConditionSchema).optional() })
      .strict()
      .optional(),
    decision: DecisionSchema,
    risk: RiskSchema,
  })
  .strict();
export type PolicyRule = z.infer<typeof RuleSchema>;

export const PolicyDocumentSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    defaultDecision: z.literal("DENY"),
    defaultRisk: RiskSchema,
    rules: z.array(RuleSchema).min(1),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const r of doc.rules) {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate rule id ${r.id}` });
      seen.add(r.id);
      if (r.tool !== "*" && !isToolName(r.tool))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Rule ${r.id} references unknown tool ${r.tool}` });
    }
  });
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

export interface LoadedPolicy {
  doc: PolicyDocument;
  /** Human version plus a content hash, so any edit to the file changes the version. */
  version: string;
}

export function loadPolicy(doc: unknown): LoadedPolicy {
  const parsed = PolicyDocumentSchema.parse(doc);
  return { doc: parsed, version: `${parsed.version}+${sha256(canonicalJson(parsed)).slice(0, 12)}` };
}

export function loadPolicyFile(path: string): LoadedPolicy {
  return loadPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export interface EvaluationInput {
  tool: string;
  args: Record<string, unknown>;
  state: unknown;
  constraints: UserConstraint[];
  now: Date;
}

function getFact(facts: Record<string, unknown>, path: string): unknown {
  let cur: unknown = facts;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function conditionHolds(c: Condition, facts: Record<string, unknown>): boolean {
  const v = getFact(facts, c.fact);
  switch (c.op) {
    case "exists":
      return v !== undefined;
    case "eq":
      return v !== undefined && canonicalJson(v) === canonicalJson(c.value);
    case "neq":
      return v !== undefined && canonicalJson(v) !== canonicalJson(c.value);
    case "in":
      return Array.isArray(c.value) && c.value.some((x) => canonicalJson(x) === canonicalJson(v));
    case "nin":
      return v !== undefined && Array.isArray(c.value) && !c.value.some((x) => canonicalJson(x) === canonicalJson(v));
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (typeof v !== "number" || typeof c.value !== "number" || !Number.isFinite(v)) return false;
      if (c.op === "lt") return v < c.value;
      if (c.op === "lte") return v <= c.value;
      if (c.op === "gt") return v > c.value;
      return v >= c.value;
    }
  }
}

function ruleMatches(rule: PolicyRule, tool: string, facts: Record<string, unknown>): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  if (!rule.when) return true;
  const all = rule.when.all ?? [];
  const any = rule.when.any ?? [];
  if (!all.every((c) => conditionHolds(c, facts))) return false;
  if (any.length > 0 && !any.some((c) => conditionHolds(c, facts))) return false;
  return true;
}

const stricter = (a: Decision, b: Decision): Decision => (DECISION_ORDER[a] >= DECISION_ORDER[b] ? a : b);
const higherRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

/**
 * Pure, deterministic evaluation. Same inputs → same output. No model output is consulted beyond
 * the (already validated) tool name and arguments.
 */
export function evaluate(policy: LoadedPolicy, input: EvaluationInput): PolicyEvaluation {
  const evaluatedAt = input.now.toISOString();
  const base = { policyVersion: policy.version, evaluatedAt, constraintsApplied: [] as string[] };

  if (!isToolName(input.tool)) {
    return {
      ...base,
      decision: "DENY",
      baseDecision: "DENY",
      risk: "CRITICAL",
      ruleId: "catalog.unknown_tool",
      reason: `"${input.tool.slice(0, 64)}" is not a tool in the SentryFlow catalog.`,
      trace: [],
    };
  }
  const validation = validateToolArgs(input.tool, input.args);
  if (!validation.ok) {
    return {
      ...base,
      decision: "DENY",
      baseDecision: "DENY",
      risk: "HIGH",
      ruleId: "schema.invalid_args",
      reason: `Arguments failed validation: ${validation.errors.join("; ")}`,
      trace: [],
    };
  }

  const args = validation.args;
  const facts = { args, state: input.state, derived: derivedFacts(input.tool, args) };
  const trace: RuleTrace[] = [];
  let matched: PolicyRule | undefined;
  for (const rule of policy.doc.rules) {
    if (rule.tool !== "*" && rule.tool !== input.tool) continue;
    const ok = ruleMatches(rule, input.tool, facts);
    trace.push({ ruleId: rule.id, matched: ok });
    if (ok) {
      matched = rule;
      break;
    }
  }

  let decision: Decision = matched ? matched.decision : policy.doc.defaultDecision;
  let risk: RiskLevel = matched ? matched.risk : policy.doc.defaultRisk;
  const baseDecision = decision;
  let reason = matched ? matched.description : "No policy rule matched; default deny.";
  const ruleId = matched ? matched.id : "default.deny";

  // User constraints can only tighten the decision — never loosen it.
  const cats = categoriesFor(input.tool, args);
  const applied: string[] = [];
  for (const c of input.constraints) {
    if (!c.categories.some((cat) => cats.includes(cat))) continue;
    const next = stricter(decision, c.effect);
    if (next !== decision) {
      decision = next;
      applied.push(c.id);
      reason += ` Tightened by your instruction: "${c.sourceText}".`;
      if (decision === "REQUIRE_APPROVAL") risk = higherRisk(risk, "HIGH");
      if (decision === "DENY") risk = higherRisk(risk, "HIGH");
    }
  }

  return { ...base, decision, baseDecision, risk, ruleId, reason, trace, constraintsApplied: applied };
}
