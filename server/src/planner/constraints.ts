import type { ToolCategory } from "../domain/catalog.js";
import type { UserConstraint } from "../domain/types.js";

/**
 * Deterministic extraction of user-stated restrictions ("never unlock a door without approval").
 *
 * Security property: the output of this function can only make policy STRICTER. A missed phrase
 * means the base policy applies; a false positive means an extra approval prompt. Neither can turn a
 * denied action into an allowed one, so this is safe to run on untrusted text.
 */

const NEGATION = /\b(never|don'?t|do not|must not|mustn'?t|should not|shouldn'?t|no one should|not allowed to)\b/i;
const NEEDS_APPROVAL =
  /\b(without (my |explicit |prior |express |first )*(approval|permission|confirmation|consent|asking( me)?|checking with me)|unless (i|you) (approve|confirm|say so|ask)|ask (me )?first|until i approve)\b/i;

const CATEGORY_PATTERNS: { category: ToolCategory; pattern: RegExp; label: string }[] = [
  { category: "unlock", pattern: /\bunlock\w*|\bopen(ing)? (a |the |any )?(front |back )?doors?\b/i, label: "unlocking doors" },
  {
    category: "security",
    pattern:
      /\b(disabl\w*|disarm\w*|deactivat\w*|turn(ing)? off|switch(ing)? off|stop(ping)?)\b[^.,;]*\b(security|alarm|cameras?|recording)\b|\bdisarm\w*/i,
    label: "disabling security",
  },
  { category: "purchase", pattern: /\b(purchas\w*|buy\w*|spend\w*|ordering|(?<!in )orders?\b|checkout|pay\w*)\b/i, label: "purchases" },
];

/** Splits text into sentences; each sentence is examined on its own. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns the index at which a restriction starts inside a sentence, or -1. */
export function restrictionStart(sentence: string): number {
  const m = NEGATION.exec(sentence);
  return m ? m.index : -1;
}

export function extractConstraints(request: string): UserConstraint[] {
  const out: UserConstraint[] = [];
  let n = 0;
  for (const sentence of sentences(request.slice(0, 2000))) {
    const start = restrictionStart(sentence);
    if (start < 0) continue;
    const clause = sentence.slice(start);
    const categories = CATEGORY_PATTERNS.filter((c) => c.pattern.test(clause)).map((c) => c.category);
    if (categories.length === 0) continue;
    out.push({
      id: `uc_${++n}`,
      categories,
      effect: NEEDS_APPROVAL.test(clause) ? "REQUIRE_APPROVAL" : "DENY",
      sourceText: clause.replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return out;
}

export function describeConstraint(c: UserConstraint): string {
  const labels = c.categories.map((cat) => CATEGORY_PATTERNS.find((p) => p.category === cat)?.label ?? cat);
  return `${c.effect === "DENY" ? "Never allow" : "Require approval for"} ${labels.join(", ")}`;
}
