# Assumptions and Verified Requirements

Sources were read on 2026-10-10.

## Verified (from official sources)

| Requirement | Source |
|-------------|--------|
| Alexa+ track: working Agent Skill **or** self-hosted MCP server implementing MCP spec **2025-11-25 or later over Streamable HTTP** | amazonappdev2026.devpost.com/rules — Submission Requirements |
| Alternative path: a **simulated Alexa+ experience** built with any agentic tooling is accepted; demo must clearly show the simulated experience | same |
| Repository must show the track technology imported and called at runtime (not just named in a README) | same |
| Submission period ends **Friday, October 23, 2026, 12:00 PM PT** | same |
| Demo video under 3 minutes; product feedback required; friction log optional (up to 10% bonus) | same |
| Open Source mini-challenge: new OSS project or contribution alongside a primary submission | same |
| Alexa+ MCP servers must support Streamable HTTP; legacy HTTP+SSE must be migrated | developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html |
| Alexa+ auth: unauthenticated requests → `401` **without** `WWW-Authenticate`; RFC 9728 PRM; OAuth 2.1 auth-code + PKCE S256; no DCR | same |
| Alexa+ latency target: round trip < 500 ms | same |
| Alexa+ tool responses use `structuredContent` plus a text `content` block | …/mcp-toolkit-client-lifecycle.html |

## Decisions and assumptions

* **Path**: SentryFlow is a real self-hosted MCP server (Streamable HTTP, `2025-11-25`) **plus** a
  web app that simulates the Alexa+ experience. It is not onboarded to Alexa+ — that requires the
  owner's Amazon developer credentials, a public HTTPS endpoint, and an OAuth 2.1 authorization
  server, none of which exist in this local build.
* **Auth**: static bearer tokens per role. `401` responses omit `WWW-Authenticate`, matching the
  Alexa+ checklist, but there is no PRM document or OAuth server. This is a documented gap, not a
  claim of compliance.
* **Latency**: plan generation through a local 3B model takes seconds, far above 500 ms. All
  non-planning tools are designed to be fast; the planner can be switched to the rule-based
  provider for sub-100 ms planning. This trade-off is documented in the README.
* **Model**: `qwen2.5:3b` (already installed, 1.9 GB, fits a 4 GB RTX 3050 laptop GPU).
* **Devices**: entirely simulated; no Ring, Alexa, or other real device is contacted.
* **Purchases**: simulated orders only; no payment details exist anywhere in the system.

## Unverified ideas (not built)

* Packaging as an Alexa+ add-on (`alexa-ai new mcp`) — needs credentials.
* MCP Apps (`ui://` resources) for visual cards.
* OAuth 2.1 authorization server for account linking.
