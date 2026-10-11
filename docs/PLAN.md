# Implementation Plan

Each milestone ends with its checks passing before the next begins.

| M | Milestone | Verified by |
|---|-----------|-------------|
| 1 | Repo scaffold: npm workspaces, TS, ESLint, Vitest, `.gitignore`, `.env.example` | `npm run typecheck`, `npm run lint` |
| 2 | Domain: tool catalog, zod schemas, canonical hashing | unit tests |
| 3 | Policy engine + default policy + constraint extraction | unit tests incl. adversarial |
| 4 | Store, audit hash chain, simulated environment executors | unit tests (state really changes, chain verifies, tamper detected) |
| 5 | Planner: rule fallback + Ollama provider + validation | unit tests with malformed model output; live Ollama smoke test |
| 6 | Service: lifecycle, approvals, revalidation, dependency execution | integration tests for every gate below |
| 7 | MCP server over Streamable HTTP + auth + health | protocol tests with SDK client over real HTTP |
| 8 | Web client as genuine MCP client; all seven views | typecheck, lint, browser run-through |
| 9 | Docs, demo script, feedback, friction log, generated test report | `npm run report` from actual runs |

All nine milestones were completed. Issues found while verifying, and fixed:

* Model output with an own `__proto__` key slipped past zod's record parser (found by an adversarial test) → raw-value key scan.
* A skipped action could still be approved (found by the live model run) → terminal actions refuse approval; pending approvals are withdrawn.
* Approved actions kept a stale "awaiting approval" reason → cleared on approval.
* Browser effect returned a Promise (`scrollIntoView` in newer Chromium) → fixed.
* Audit view re-fetched in a loop because context actions changed identity → actions memoized.
* Server restarts left browser sessions dead, and parallel retries raced → single-flight re-initialization on 404.

## Verification gates (final)

1. Install from README instructions.
2. Frontend starts.
3. Backend + MCP start; `/health` OK.
4. MCP initialize, `tools/list`, `tools/call` over Streamable HTTP.
5. ALLOW action changes persisted state.
6. REQUIRE_APPROVAL action stays blocked until approval.
7. DENY action never executes.
8. Edited args invalidate approval.
9. Audit reflects real events; chain verifies; tampering detected.
10. Tests, lint, typecheck pass (or failures documented).
11. Works with no paid services.
12. No secrets / fabricated results in repo.
