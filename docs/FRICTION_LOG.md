# Friction Log

Real friction met while building SentryFlow. Each entry records what was observed; nothing is
hypothetical. Severity: Low / Medium / High.

## Amazon developer tooling and documentation

### F1 — Conflicting MCP protocol versions in Alexa+ docs (Medium)

* **Task:** Choose which MCP protocol version the server must speak for Alexa+.
* **Steps:** Read the hackathon rules (MCP 2025-11-25 minimum), the Alexa+ MCP QuickStart
  (2025-11-25, legacy HTTP+SSE deprecated), then the *Alexa+ MCP Client and App Lifecycle* page.
* **Expected:** All examples use 2025-11-25.
* **Actual:** The Lifecycle page's example `initialize` request and response use
  `"protocolVersion": "2025-03-26"`.
* **Workaround:** Built on the MCP SDK's `LATEST_PROTOCOL_VERSION` (2025-11-25), which also
  negotiates down to older versions, so either client would work.
* **Suggestion:** Update the examples to 2025-11-25, and state which versions the Alexa+ client
  sends and whether servers must support older ones.

### F2 — 401 guidance differs from the MCP authorization spec, without explanation (Medium)

* **Task:** Implement unauthenticated-request behaviour.
* **Steps:** Read the QuickStart's authentication checklist.
* **Expected:** Guidance consistent with the MCP authorization spec, where `WWW-Authenticate` on a
  401 is the standard way to point clients at the protected-resource metadata (alongside the
  well-known URI).
* **Actual:** The checklist requires a 401 **without** `WWW-Authenticate`, and lists the header as
  "not supported yet".
* **Workaround:** Followed the Alexa+ checklist (tested: `401`, no header) and documented the divergence.
* **Suggestion:** One sentence on why, and how Alexa+ discovers PRM instead (well-known URI only?).

### F3 — No credential-free way to see Alexa+ call a local MCP server (High for evaluation, by design)

* **Task:** Verify end-to-end that Alexa+ can drive SentryFlow's tools.
* **Steps:** QuickStart → `alexa-ai configure` (Login with Amazon) → public HTTPS endpoint →
  OAuth 2.1 auth server with PKCE and PRM → `alexa-ai new mcp` → deploy → web simulator.
* **Expected:** A development mode to try tool selection and conversation against a local server
  before building OAuth.
* **Actual:** Every path to the real Alexa+ client needs account credentials, a public URL and a
  full OAuth implementation.
* **Workaround:** Used the rules' permitted "simulated Alexa+ experience" path; documented exactly
  which Alexa+ requirements are met and which are not (docs/MCP_INTERFACE.md).
* **Suggestion:** A mock-auth mode in the web simulator for development-stage add-ons.

### F4 — Local Inspector needs Node.js 24+ and a console login to install (Low)

* **Task:** Run Amazon's Local Inspector in data-layer mode against SentryFlow.
* **Steps:** Read the Local Inspector page: prerequisites are Node.js 24+, the
  `@alexa-ai/addon-local-inspector` CLI installed via the Developer Console's Getting Started guide.
* **Expected:** An npm-installable tool that runs on the current Node LTS used by most projects.
* **Actual:** Our environment runs Node 20.20; installation is gated behind a console login.
* **Workaround:** Not used. Built our own smoke test with the official MCP SDK client
  (`npm run smoke`) that checks the data layer: initialize, tools/list, tool calls, errors.
* **Suggestion:** Support Node 20/22 LTS and publish the CLI publicly; keep the console-gated parts
  (certification verdicts) separate.

### F5 — "Security and data policies" section not yet published (Medium)

* **Task:** Align an add-on that can unlock doors and place orders with Amazon's security and data
  expectations for Alexa+ MCP add-ons.
* **Steps:** Read the Alexa+ MCP QuickStart end to end, looking for policy guidance on sensitive
  actions (confirmations, purchases, locks, data handling).
* **Expected:** Concrete requirements, for example which actions need explicit customer confirmation.
* **Actual:** The QuickStart says the section "will be published in a future revision".
* **Workaround:** Wrote our own threat model, required owner approval bound to exact arguments for
  purchases and unlocking, and made the agent unable to approve its own actions.
* **Suggestion:** Publish even a short interim list (confirmation for purchases, handling of locks and
  security devices) so builders can design to it from day one.

## Wider ecosystem (not Amazon tooling, recorded for completeness)

### E1 — MCP TypeScript SDK security advisory on the version we first chose (Medium)

* **Task:** Pin a stable MCP TypeScript SDK version for the server and the browser client.
* **Steps:** Installed `@modelcontextprotocol/sdk` 1.30.1, then ran `npm audit`.
* **Expected:** A clean audit for a current release.
* **Actual:** `npm audit` flagged GHSA-6qxp-vccf-f47h (OAuth client could send credentials to an
  authorization server chosen by the MCP server) for SDK ≤ 1.30.1.
* **Workaround:** Pinned 1.31.0. SentryFlow does not use the SDK's OAuth client, but the browser
  bundle includes the client package.
* **Suggestion:** Call out security fixes prominently in the SDK release notes so pinned projects
  notice them.

### E2 — Small local model misreads restrictions as commands (Medium, handled)

* **Task:** Plan the demo request with a local 3B model.
* **Steps:** Sent *"… Never unlock a door, disable security, or make purchases without explicit
  approval"* to `qwen2.5:3b` through Ollama with a JSON schema.
* **Expected:** No action for sentences that are restrictions; dependencies only where needed.
* **Actual:** The model turned *"Never … disable security …"* into a `set_security_mode
  {"mode":"disarmed"}` action, and chained every action to the previous one. The policy denied
  the disarm; the chained dependencies caused a valid purchase to be skipped.
* **Workaround:** Prompt changes (restrictions produce no action; dependencies only when needed) fixed
  both in three of three re-runs. Policy remained the safety net regardless, and a regression test
  reproduces the original model output.
* **Suggestion:** Never rely on the model to honour restrictions; enforce them in deterministic code.

### E3 — Server restarts invalidate browser MCP sessions (Low, fixed)

* **Task:** Keep the browser MCP client working across server restarts during development.
* **Steps:** Restarted the server while the web UI held open MCP sessions, then triggered tool calls.
* **Expected:** The client recovers transparently.
* **Actual:** Calls returned `404 Session not found`, and parallel calls each tried to reconnect,
  racing each other.
* **Workaround:** Single-flight re-initialization on 404, as the MCP spec prescribes. Verified in the
  traffic log: `404 → initialize → notifications/initialized → tools/list → retry 200`.
* **Suggestion:** The SDK client could offer opt-in automatic re-initialization on session loss.
