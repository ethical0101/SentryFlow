# Architecture

## Components

```mermaid
flowchart LR
  subgraph Browser["Web client (React, simulated Alexa+)"]
    UI[Views: workspace, plan, policy inspector,<br/>approvals, environment, audit, system]
    AC[MCP Client — agent role]
    PC[MCP Client — approver role]
    UI --> AC
    UI --> PC
  end

  subgraph Server["SentryFlow server (Node + Express)"]
    HTTP[/POST GET DELETE /mcp<br/>Streamable HTTP/]
    AUTH[Bearer auth + Origin check]
    MCP[McpServer per session<br/>official TS SDK]
    SVC[SentryFlow service<br/>orchestrator]
    PLN[Planner<br/>Ollama ➜ fallback rules]
    VAL[Schema validation<br/>zod]
    POL[Policy engine<br/>deterministic]
    APR[Approval binding<br/>in service]
    EXE[Tool executor<br/>simulated household]
    STO[(state.json<br/>atomic writes)]
    AUD[(audit.jsonl<br/>hash chain)]
    HEALTH[/GET /health/]
  end

  OLL[(Ollama<br/>localhost:11434)]

  AC -- JSON-RPC over Streamable HTTP --> HTTP
  PC -- JSON-RPC over Streamable HTTP --> HTTP
  HTTP --> AUTH --> MCP --> SVC
  SVC --> PLN --> OLL
  PLN --> VAL
  SVC --> POL
  SVC --> APR
  SVC --> EXE --> STO
  APR --> STO
  SVC --> AUD
```

## Data flow for one request

```mermaid
sequenceDiagram
  participant U as Owner (web UI)
  participant A as Agent MCP client
  participant S as SentryFlow MCP server
  participant M as Ollama (untrusted)
  participant P as Policy engine
  participant H as Household sim
  participant L as Audit log

  U->>A: "I'm leaving… never unlock a door without approval"
  A->>S: tools/call sentryflow_plan_request
  S->>L: REQUEST_RECEIVED
  S->>M: prompt + tool catalog + JSON schema
  M-->>S: proposed actions (untrusted JSON)
  S->>S: zod validation, strip unknown fields, drop invalid
  S->>P: evaluate(tool, args, state, user constraints)
  P-->>S: decision + rule id + policy version
  S->>L: PLAN_CREATED, POLICY_EVALUATED×n
  S-->>A: plan (structuredContent)
  A->>S: sentryflow_execute_plan
  S->>P: re-evaluate each action against *current* state
  S->>H: execute ALLOW actions in dependency order
  S->>L: ACTION_EXECUTED / ACTION_BLOCKED
  U->>S: (approver client) sentryflow_resolve_approval(actionId, argsHash, approve)
  S->>L: APPROVAL_GRANTED
  A->>S: sentryflow_execute_action(actionId)
  S->>S: verify approval: hash, expiry, single-use, policy version, state
  S->>H: execute
  S->>L: ACTION_EXECUTED
```

## Module boundaries (`server/src`)

| Module | Responsibility | Trusts |
|--------|----------------|--------|
| `domain/` | Tool catalog, zod schemas, canonical hashing, dangerous-key checks | — |
| `planner/` | Ollama provider, rule-based fallback, constraint extraction | Nothing it returns is trusted |
| `policy/` | Pure, deterministic rule evaluation | Policy file (validated on load) |
| `environment/` | Simulated household tool executors (also range-check args: defense in depth) | Store |
| `store/` | JSON persistence, atomic write, async mutex | Disk |
| `audit/` | Append-only hash-chained log + verification | Disk |
| `service/` | Orchestrates the lifecycle, including approval binding, expiry and single-use consumption; the **only** caller of executors | All of the above |
| `mcp/` | MCP tool definitions, role checks, result formatting | Service |
| `http/` | Express app, Streamable HTTP transport, auth, Origin check, health | — |

The web client (`web/src`) contains **no authorization logic**. It renders state returned by MCP
tool calls and sends user intent back. Removing the UI does not weaken any guarantee.

## Roles

| Role | Credential | Can | Cannot |
|------|-----------|-----|--------|
| `agent` | `SENTRYFLOW_AGENT_TOKEN` | plan, inspect, edit args, request approval, execute | resolve approvals |
| `approver` | `SENTRYFLOW_APPROVER_TOKEN` | everything `agent` can read, resolve approvals | — |

Separating the roles means an agent that is prompt-injected into calling
`sentryflow_resolve_approval` gets a `FORBIDDEN` error rather than approving its own action.

## Persistence

* `data/state.json` — devices, plans, approvals. Written atomically (temp file + rename) behind a
  single async mutex; the server is single-process by design.
* `data/audit.jsonl` — one JSON record per line; each record carries `prevHash` and
  `hash = SHA-256(prevHash ‖ canonical(record))`. See THREAT_MODEL.md for what this does and does
  not guarantee.

## Why these choices

* **Express + official SDK `StreamableHTTPServerTransport`**: the SDK implements session headers,
  protocol version negotiation, SSE framing and JSON-RPC errors; we would get those wrong by hand.
* **JSON file store instead of SQLite**: Node 20 has no built-in SQLite and native modules are a
  common Windows install failure. The data set is tiny and single-writer.
* **Two MCP connections in the browser**: makes the agent/approver separation visible and real.
