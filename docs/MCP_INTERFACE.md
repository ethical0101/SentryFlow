# MCP Interface

| | |
|---|---|
| Endpoint | `POST / GET / DELETE http://127.0.0.1:8787/mcp` |
| Transport | Streamable HTTP (stateful sessions via `mcp-session-id`) |
| Protocol | `2025-11-25` (negotiated by the SDK; older versions the SDK supports are accepted) |
| SDK | `@modelcontextprotocol/sdk` 1.31.0 (`McpServer` + `StreamableHTTPServerTransport`) |
| Server info | `{ name: "sentryflow", version: "1.0.0" }`, capabilities `tools`, `logging` |
| Auth | `Authorization: Bearer <token>`; the token decides the session's role |
| Health | `GET /health` (no auth; no secrets) |

## Roles

| Role | Token | Notes |
|---|---|---|
| `agent` | `SENTRYFLOW_AGENT_TOKEN` | Everything except approver-only tools |
| `approver` | `SENTRYFLOW_APPROVER_TOKEN` | Everything, including approvals and simulation controls |

A session is bound to the role that created it. Using a session id with the other role's token
returns `403`.

## HTTP behaviour

| Case | Response |
|---|---|
| Missing or invalid bearer token | `401` JSON-RPC error, **no** `WWW-Authenticate` header (Alexa+ checklist) |
| `Origin` not in `SENTRYFLOW_ALLOWED_ORIGINS` | `403` |
| Non-initialize request without `mcp-session-id` | `400` |
| Unknown / expired `mcp-session-id` | `404` → the client must initialize a new session (the web client does this automatically) |
| Unsupported `mcp-protocol-version` header | `400` (SDK) |
| Malformed JSON | `400` with JSON-RPC `-32700` |
| Body over 64 KB | `413` |

## Tool results

Every tool returns `structuredContent` (the machine-readable result) and a single `text` block (a
short, speakable summary — the shape the Alexa+ client lifecycle documentation shows). Errors are
returned as tool results with `isError: true` and
`structuredContent.error = { code, message }`, where `code` is one of `NOT_FOUND`,
`INVALID_ARGUMENT`, `FORBIDDEN`, `CONFLICT`, `DUPLICATE_EXECUTION`, `APPROVAL_MISMATCH`,
`APPROVAL_EXPIRED`, `POLICY_DENIED`, `TOOL_FAILURE`, `INTERNAL`. Input that fails a tool's schema is
rejected by the SDK before the handler runs.

## Tools

| Tool | Role | Annotations | Input | Result (`structuredContent`) |
|---|---|---|---|---|
| `sentryflow_plan_request` | agent | not read-only | `request` (1–2000 chars), `planner?` `auto\|ollama\|rules` | `{ plan, voiceSummary }` |
| `sentryflow_get_plan` | agent | read-only | `planId` | `{ plan }` |
| `sentryflow_list_plans` | agent | read-only | `limit?` 1–50 | `{ plans }` |
| `sentryflow_evaluate_action` | agent | read-only | `tool`, `args`, `planId?` | `{ evaluation }` — dry run, never executes |
| `sentryflow_get_policy` | agent | read-only | — | `{ version, policy, tools, approvalTtlSeconds }` |
| `sentryflow_get_device_state` | agent | read-only | — | `{ household }` |
| `sentryflow_update_action` | agent | not destructive | `planId`, `actionId`, `args` | `{ action }` — invalidates any approval |
| `sentryflow_list_pending_approvals` | agent | read-only | — | `{ pending[] }` with `argsHash` |
| `sentryflow_request_approval` | agent | idempotent | `planId`, `actionId` | `{ action }` — after expiry/invalidation; refused for DENY |
| `sentryflow_resolve_approval` | **approver** | — | `planId`, `actionId`, `decision` `approve\|reject`, `argsHash` (64 hex), `note?` | `{ action }` |
| `sentryflow_execute_action` | agent | **destructive** | `planId`, `actionId` | `{ action }` — gated; `DUPLICATE_EXECUTION` if already finished |
| `sentryflow_execute_plan` | agent | destructive, idempotent | `planId` | `{ summary, plan }` |
| `sentryflow_get_receipt` | agent | read-only | `planId` | `{ receipt }` incl. timeline and chain verification |
| `sentryflow_get_audit_log` | agent | read-only | `planId?`, `limit?` 1–500 | `{ records, integrity }` |
| `sentryflow_system_status` | agent | read-only | — | server, MCP, planner, policy, audit, session role |
| `sentryflow_reset_environment` | **approver** | destructive (simulation) | `clearPlans?` | `{ household }` — audit log is never cleared |
| `sentryflow_set_device_fault` | **approver** | — | `deviceId`, `offline` | `{ household }` — simulated faults |

Identifiers are validated by pattern (`plan_[a-f0-9]+`, `act_[a-f0-9]+`), so path-like or oversized
ids never reach the service.

## Household tools (what actions can do)

These are **not** MCP tools; they are the operations an action may name, validated by the catalog
in [server/src/domain/catalog.ts](../server/src/domain/catalog.ts).

| Tool | Arguments |
|---|---|
| `get_device_state`, `get_security_status` | `{}` |
| `set_light` | `lightId` ∈ living_room, kitchen, bedroom, porch, all; `on`; `brightness?` 0–100 |
| `set_thermostat` | `mode` ∈ heat, cool, auto, eco, off; `targetC?` |
| `lock_door`, `unlock_door` | `doorId` ∈ front_door, back_door |
| `set_security_mode` | `mode` ∈ disarmed, armed_home, armed_away |
| `set_camera_recording` | `cameraId` ∈ front_door_cam, backyard_cam; `recording` |
| `enable_routine` | `routineId` ∈ leaving_home, good_night, vacation_mode |
| `purchase_item` | `sku` ∈ catalog; `quantity` 1–10 (price comes from the server-side catalog) |

## Typical agent flow

```
initialize → notifications/initialized → tools/list
tools/call sentryflow_plan_request      { request }
tools/call sentryflow_execute_plan      { planId }                 # ALLOW actions run
  … owner, in an approver session:
tools/call sentryflow_list_pending_approvals
tools/call sentryflow_resolve_approval  { planId, actionId, decision: "approve", argsHash }
  … agent:
tools/call sentryflow_execute_plan      { planId }                 # approved actions run, once
tools/call sentryflow_get_receipt       { planId }
```

`npm run smoke` performs exactly this flow and prints each step.

## Alexa+ readiness (honest status)

| Alexa+ MCP requirement | Status |
|---|---|
| Streamable HTTP | ✅ |
| Spec 2025-11-25 | ✅ (SDK `LATEST_PROTOCOL_VERSION`) |
| `401` without `WWW-Authenticate` | ✅ |
| Remote HTTPS URL | ❌ local only (a tunnel would work technically; not done) |
| RFC 9728 Protected Resource Metadata, OAuth 2.1 + PKCE S256 | ❌ not implemented (static bearer tokens) |
| < 500 ms round trip | ✅ for every tool except model-backed planning (seconds); `planner: "rules"` plans in milliseconds |
| `structuredContent` + text content | ✅ |
| MCP Apps (`ui://` resources) | ❌ not implemented; the web client renders its own UI |
