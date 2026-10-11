# Policy Model

The policy engine ([server/src/policy/engine.ts](../server/src/policy/engine.ts)) is a pure function:

```
evaluate(policy, { tool, args, state, constraints, now }) → { decision, risk, ruleId, reason, baseDecision,
                                                              constraintsApplied, trace, policyVersion }
```

Same inputs, same output. It never sees the model's explanation, and nothing the model says about
safety, approval or risk is an input.

## Evaluation order

1. **Catalog check** — the tool must exist in the catalog. Otherwise `DENY` (`catalog.unknown_tool`).
2. **Schema check** — arguments must pass the tool's strict schema (no extra keys, enums, ranges,
   no `__proto__`/`constructor`/`prototype` keys). Otherwise `DENY` (`schema.invalid_args`).
3. **Rules** — evaluated top to bottom; rules for other tools are skipped; **the first match wins**.
4. **Default** — nothing matched → `DENY` (`default.deny`). The policy schema refuses any other default.
5. **User constraints** — restrictions extracted from the request can raise the decision
   (`ALLOW → REQUIRE_APPROVAL → DENY`), never lower it.

## Rule format

```json
{
  "id": "locks.unlock_while_away",
  "description": "Doors cannot be unlocked by the agent while the system is armed away.",
  "tool": "unlock_door",
  "when": { "all": [{ "fact": "state.security.mode", "op": "eq", "value": "armed_away" }] },
  "decision": "DENY",
  "risk": "CRITICAL"
}
```

| Field | Meaning |
|---|---|
| `tool` | Tool name, or `*` |
| `when.all` / `when.any` | Conditions; all of `all` and at least one of `any` must hold |
| `fact` | `args.*` (validated arguments), `state.*` (current simulated household), `derived.*` (computed from trusted data, e.g. `derived.totalUsd` from the product catalog price) |
| `op` | `eq`, `neq`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`, `exists`. Numeric comparisons on missing or non-numeric facts are false |
| `decision` | `ALLOW`, `REQUIRE_APPROVAL`, `DENY` |
| `risk` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` — shown to the owner; assigned only by rules |

The file is validated at load: unknown keys, unknown tools, duplicate rule ids and a non-`DENY`
default all fail startup.

## Versioning

`policyVersion = "<version field>+<first 12 hex of SHA-256(canonical policy JSON)>"`, for example
`1.0.0+edca194e857b`. Any edit to the file changes the version, even if the author forgets to bump
the version string. Approvals record the version they were granted under; if it differs at execution
time, the approval is invalidated and the owner is asked again.

## Default household policy

[server/policy/default-policy.json](../server/policy/default-policy.json)

| Tool | Condition | Decision | Risk |
|---|---|---|---|
| `get_device_state`, `get_security_status` | — | ALLOW | LOW |
| `set_light` | — | ALLOW | LOW |
| `set_thermostat` | `targetC < 16` | DENY | MEDIUM |
| `set_thermostat` | `targetC > 28` | DENY | MEDIUM |
| `set_thermostat` | `mode = off` | REQUIRE_APPROVAL | MEDIUM |
| `set_thermostat` | otherwise | ALLOW | LOW |
| `lock_door` | — | ALLOW | LOW |
| `unlock_door` | security is `armed_away` | DENY | CRITICAL |
| `unlock_door` | otherwise | REQUIRE_APPROVAL | HIGH |
| `set_security_mode` | `mode = disarmed` | DENY | CRITICAL |
| `set_security_mode` | otherwise (arming) | ALLOW | MEDIUM |
| `set_camera_recording` | `recording = false` | DENY | CRITICAL |
| `set_camera_recording` | otherwise | ALLOW | LOW |
| `enable_routine` | `routineId ∈ {leaving_home, good_night}` | ALLOW | MEDIUM |
| `enable_routine` | otherwise | REQUIRE_APPROVAL | MEDIUM |
| `purchase_item` | `derived.totalUsd > 100` | DENY | HIGH |
| `purchase_item` | otherwise | REQUIRE_APPROVAL | HIGH |
| anything else | — | DENY | CRITICAL |

Defense in depth: the simulated thermostat itself refuses targets outside 10–32 °C even if a policy
were edited to allow them.

## User constraints

[server/src/planner/constraints.ts](../server/src/planner/constraints.ts) scans each sentence of the
request for a negation (`never`, `don't`, `do not`, `must not`, …). From the negation onwards it
looks for categories:

| Category | Matches | Tools |
|---|---|---|
| `unlock` | unlock…, open the door | `unlock_door` |
| `security` | disable/disarm/turn off … security/alarm/camera/recording | `set_security_mode{disarmed}`, `set_camera_recording{false}` |
| `purchase` | purchase, buy, order, spend, checkout, pay | `purchase_item` |

If the clause also says *without approval / permission / confirmation / asking*, the effect is
`REQUIRE_APPROVAL`; otherwise `DENY`. Constraint clauses are also excluded from the rule planner, so
*"never unlock a door"* does not plan an unlock.

There is deliberately **no grammar for permission**. *"You may buy coffee without asking"* yields no
constraint and the base policy applies.

## Re-evaluation

Policy is evaluated at plan time (for display), again when an approval is requested or granted, and
again immediately before execution against the then-current state. Only the last evaluation
authorizes anything. Changes are recorded in the audit log (`POLICY_EVALUATED` with `phase` and the
previous decision).

## Editing the policy

1. Copy `server/policy/default-policy.json` and edit it.
2. Set `SENTRYFLOW_POLICY_FILE` to the new file and restart.
3. Check it in **Policy inspector** with the dry-run evaluator or `sentryflow_evaluate_action`.
4. Outstanding approvals from the old version will require re-approval.
