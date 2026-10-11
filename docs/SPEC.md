# SentryFlow — Product Specification

## Problem

Voice and chat agents (Alexa+, coding agents, home assistants) are increasingly able to *act*: turn
things on, unlock things, buy things. Today the line between "the model decided" and "the system
allowed" is usually blurry. If the model is the only thing deciding whether an action is safe, a
prompt injection, a misheard utterance, or a hallucinated tool call becomes a real-world action.

## Product

SentryFlow is a **permission-aware execution layer** that sits between an agent and the tools it
operates. It is exposed as a self-hosted **MCP server over Streamable HTTP** and ships with a web
client that acts as a **simulated Alexa+ household experience**.

```
natural-language request
   → model proposes a plan (untrusted)
   → strict schema validation
   → deterministic policy engine (ALLOW / REQUIRE_APPROVAL / DENY)
   → human approval bound to the exact arguments
   → revalidation immediately before execution
   → controlled execution against a simulated household
   → hash-chained audit trail + human-readable receipt
```

## Users

* **Household owner** — talks to the (simulated) assistant, reviews and approves sensitive actions.
* **Agent** — any MCP client (the bundled web client, MCP Inspector, or an Alexa+ add-on once
  onboarded) that plans and executes actions on the owner's behalf.
* **Judge / developer** — inspects policy, audit integrity, and MCP traffic.

## Core features (MVP scope)

| # | Feature | Acceptance |
|---|---------|-----------|
| A | Natural-language request → structured plan | Each action has id, tool, validated args, explanation, dependencies, risk, policy decision, approval status, execution status |
| B | Deterministic policy engine | Configurable JSON policy, first-match rules, default-deny, versioned, unit tested |
| C | Approval lifecycle | Pending → approved/rejected; bound to SHA-256 of tool+args; expires; single use; invalidated by edits; revalidated at execution |
| D | Simulated household | Lights, thermostat, door locks, security system, cameras, routines, simulated orders; persisted to disk |
| E | Audit + receipts | Append-only JSONL, SHA-256 hash chain, verification, per-plan receipt and timeline |
| F | MCP server | Streamable HTTP, protocol 2025-11-25, official TypeScript SDK, bearer-authenticated roles |
| G | Local AI | Ollama (`qwen2.5:3b` by default) with structured output; transparent rule-based fallback |

## Non-goals

* Real device control. Every device is simulated and labelled as such.
* Live Alexa+ connectivity. Onboarding requires an Amazon developer account, a public HTTPS URL and
  OAuth 2.1 + PKCE account linking, which this local build does not implement (see
  [ASSUMPTIONS.md](ASSUMPTIONS.md)).
* Multi-tenant identity. Two static bearer roles stand in for a real identity provider.

## Action lifecycle

```
           ┌──────────── plan created ────────────┐
           │ policy = ALLOW │ REQUIRE_APPROVAL │ DENY
           ▼                ▼                    ▼
 approval: NOT_REQUIRED    PENDING             NOT_APPLICABLE
                            │  ├─ reject → REJECTED (terminal)
                            │  ├─ ttl    → EXPIRED  (terminal until re-requested)
                            │  └─ edit   → INVALIDATED → PENDING (new hash)
                            ▼
                         APPROVED (bound to argsHash + policyVersion, expiresAt)
                            │
 execution: NOT_STARTED ──► revalidate (schema, policy, state rules, approval, dependencies)
                            ├─ fail  → BLOCKED (reason recorded, can retry later)
                            └─ pass  → RUNNING → SUCCEEDED | FAILED   (terminal, never re-run)
```

Execution statuses: `NOT_STARTED`, `BLOCKED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`.
`DENY` actions are never executable; a request to execute one is recorded as `BLOCKED`.

## Policy model (summary — full detail in [POLICY.md](POLICY.md))

* Rules are evaluated **in order; first match wins; no match → DENY**.
* A rule matches on `tool`, optional argument conditions, and optional **state conditions**
  (e.g. "unlock while security is `armed_away` → DENY").
* **User constraints** parsed deterministically from the request ("never unlock a door without
  approval") can only *tighten* a decision (ALLOW → REQUIRE_APPROVAL → DENY), never loosen it.
* The model never supplies risk or decisions. Any such fields in model output are discarded.

## Success criteria

See the verification gates in [PLAN.md](PLAN.md) and the generated [TEST_REPORT.md](TEST_REPORT.md).
