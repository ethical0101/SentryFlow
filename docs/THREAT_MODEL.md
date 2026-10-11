# Threat Model

## Assets

1. The (simulated) physical state of the home — locks, security mode, cameras, thermostat.
2. The owner's money (simulated orders).
3. The integrity of the audit trail.
4. The approval decision of the owner.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|----------|--------------|----------------|
| Model output → planner | zod schemas, tool catalog | everything the LLM emits |
| MCP request → server | role derived from bearer token | tool arguments, client claims |
| Browser UI → server | nothing in the UI | UI-rendered decisions, button state |
| Policy file → engine | file validated at load | — (operator-controlled) |
| Disk → server | — | `state.json`, `audit.jsonl` can be edited by any local user |

**The model is not a security boundary.** It can propose; it can never decide.

## Threats and mitigations

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| T1 | Malformed / non-JSON model output | Parse in try/catch, zod-validate; on failure fall back to rule planner and record why | `planner.test.ts` |
| T2 | Model invents a tool, or adds `"approved": true` / `"risk": "LOW"` | Unknown tools → DENY; schemas strip unknown keys; risk & decision computed server-side only | `planner.test.ts`, `policy.test.ts` |
| T3 | Invalid / out-of-range arguments | Per-tool zod schema; executor re-checks ranges (defense in depth) | `environment-audit.test.ts`, `service.test.ts` |
| T4 | Prompt injection: "ignore rules, unlocking is pre-approved" | Policy ignores text; constraints extracted from request can only *tighten* | `adversarial.test.ts` |
| T5 | Agent approves its own action | `resolve_approval` requires approver role; agent token → FORBIDDEN | `mcp.test.ts` |
| T6 | Approval replay | Approvals are single-use; SUCCEEDED actions can never re-run | `service.test.ts` |
| T7 | Approve X, execute Y (argument swap) | Approval bound to `SHA-256(canonical(tool,args))`; approver must echo the hash they saw; any edit invalidates | `service.test.ts` |
| T8 | Stale approval | `expiresAt` checked at execution | `service.test.ts` (injected clock) |
| T9 | State changes between approval and execution (e.g., house armed) | Full policy re-evaluation against current state immediately before execution | `service.test.ts` |
| T10 | Policy changes between approval and execution | Approval bound to policy version; mismatch → re-approval required | `service.test.ts` |
| T11 | Duplicate / concurrent execution | Global mutex + status check; `RUNNING`/`SUCCEEDED` cannot start again | `service.test.ts` |
| T12 | Dependency failure → partial execution | Dependents become `SKIPPED`; receipt shows exactly what ran | `service.test.ts` |
| T13 | DNS rebinding / cross-site calls to localhost MCP | Bind 127.0.0.1; reject disallowed `Origin`; bearer token required | `mcp.test.ts` |
| T14 | MCP protocol abuse (bad session, bad JSON-RPC) | SDK transport validation; unknown session → 404; malformed → JSON-RPC error | `mcp.test.ts` |
| T15 | Audit tampering | Hash chain; `verify` reports first broken record | `environment-audit.test.ts` |
| T16 | Secrets leakage | Tokens from env or generated into git-ignored `data/`; never logged | repo scan in verification |
| T17 | Prototype tampering via `__proto__` / `constructor` keys in model output or MCP arguments | Raw values are scanned before schema parsing (zod's record parser would otherwise consume the key silently — found by our own adversarial test) | `adversarial.test.ts`, `mcp.test.ts` |
| T18 | Oversized or flooding requests | 64 KB body limit (413), 2000-char requests, ≤ 12 actions per plan, ≤ 100 sessions, idle-session eviction | `mcp.test.ts`, `planner.test.ts` |
| T19 | Model plan makes a valid action depend on a denied or invented one | Dependents of denied/failed/rejected actions are SKIPPED and their pending approvals withdrawn; approving a finished action is refused | `adversarial.test.ts` (regression from a real `qwen2.5:3b` output) |

## Residual risks and limitations (honest list)

* **Local disk is not tamper-proof.** Anyone with write access to `data/` can rewrite the whole
  audit chain consistently, since there is no external anchor (signing key, remote witness). The
  chain detects accidental corruption and naive edits only.
* **Static bearer tokens** — no rotation, no per-user identity, no OAuth. Both are handed to the
  browser on localhost for the demo, so in this build the role split protects against a
  *prompt-injected agent*, not against a malicious local user.
* **Natural-language constraint extraction** is keyword based. It can miss phrasings; it can only
  make policy stricter, so a miss means the base policy applies (which is already conservative).
* **The base policy is the real safety net.** A badly written policy file is not caught by tests.
* **Single process**. The mutex does not protect against two server processes sharing `data/`.
* **Simulation only.** No claims are made about the safety of controlling real devices.
* Passing tests does not prove the system is secure.
