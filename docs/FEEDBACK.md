# Product Feedback (draft)

Grounded in building SentryFlow between 2026-10-10 and submission. Everything below was observed
while building; nothing is speculative. Edit freely before submitting.

## Which developer tools, APIs and SDKs did you use, and for what?

| Tool | Used for |
|---|---|
| **Model Context Protocol** — spec 2025-11-25, as required by the Alexa+ track | The product's interface: a self-hosted MCP server over Streamable HTTP |
| **MCP TypeScript SDK** (`@modelcontextprotocol/sdk` 1.31.0) | Server (`McpServer`, `StreamableHTTPServerTransport`) and both browser clients (`Client`, `StreamableHTTPClientTransport`) |
| **Alexa+ MCP documentation** (QuickStart, Client and App Lifecycle, Local Inspector, Design Guide) | Requirements: Streamable HTTP, 401 behaviour, `structuredContent` + text results, latency target, add-on manifest |
| **Ollama** + `qwen2.5:3b` | Local, free intent-to-plan model |
| Node.js 20, Express 5, zod, React 18, Vite 6, Vitest 4 | Implementation and tests |

AWS services were **not** used (no AWS Builder mini-challenge claim).

## What worked well?

* **The Streamable HTTP transport in the SDK is solid.** Session ids, protocol-version negotiation,
  SSE framing and JSON-RPC errors were handled for us; stateful sessions took about 30 lines of Express.
  The same SDK runs in the browser unchanged, so the web UI is a *real* MCP client, not a mock.
* **The Alexa+ QuickStart is concrete.** The authentication checklist (401 without
  `WWW-Authenticate`, PRM at the well-known URI, PKCE S256, no DCR) is the most precise part of the
  docs; we implemented the 401 behaviour exactly as described.
* **The Client and App Lifecycle page's tool-result example** (`structuredContent` plus a text
  block) gave a clear target shape. We return a speakable sentence as the text so a voice client has
  something natural to say.
* **The Local Inspector's design** — a localhost-only proxy with DNS-rebinding protection, plus a
  data-layer mode that needs no UI — matches what a security-minded MCP developer wants.

## What needs work?

* **Version mismatch in the docs.** The QuickStart and the hackathon rules require MCP 2025-11-25,
  but the Lifecycle page's example `initialize` request and response both use
  `"protocolVersion": "2025-03-26"`. It is unclear which version the Alexa+ client actually sends,
  and whether a server must accept older versions. (Our SDK accepts both, so we could not observe a
  failure — but we also could not confirm the real behaviour.)
* **The 401 guidance diverges from the MCP authorization spec.** The QuickStart requires *no*
  `WWW-Authenticate` header on 401, while the MCP authorization spec uses that header as the
  standard way to advertise the resource metadata URL. A short note on why Alexa+ differs, and how clients discover
  PRM instead, would save developers from second-guessing.
* **No local path to test the full Alexa+ loop.** Onboarding requires an Amazon developer login
  (`alexa-ai configure`), a public HTTPS URL and a working OAuth 2.1 server before you can see Alexa+
  call your tools. A credential-free or mock-auth development mode — even one limited to the web
  simulator — would let builders test the agent behaviour before investing in OAuth.
* **Local Inspector prerequisites.** It requires Node.js 24+ and a Developer Console login just to
  install. Many developers (including us, on Node 20) cannot use it without changing their toolchain.
* **Latency target vs. agentic tools.** The 500 ms round-trip target is clear, but the docs don't
  say how to model tools that legitimately take longer (planning, approvals). Guidance on progress
  notifications, or on splitting "start" and "check status" tools, would help.
* **Security & data policy section is "to be published".** For an add-on that can unlock or
  purchase, this is the part we most wanted to read.

## Onboarding (zero to hello world)

* **MCP server hello world:** fast — under an hour with the TypeScript SDK, including tool calls
  from a browser client.
* **Alexa+ add-on hello world:** not reached. It requires credentials, a public HTTPS endpoint and
  an OAuth server; we used the rules' permitted *simulated Alexa+ experience* path instead, and say so
  in the README and demo.

## Would you build with these devices and services again?

**Yes.** MCP is the right integration surface: our server works unchanged with any MCP client, and
the Alexa+ requirements are close to what we already built. We would come back once there's a lighter
path to test against the real Alexa+ client — we'd most like to see SentryFlow's approval step
delivered as a native Alexa confirmation, which is exactly the experience this project is about.

## Feature requests

| Request | Why it matters | Priority |
|---|---|---|
| A native "owner confirmation" primitive for MCP add-ons (Alexa asks the user, and the confirmation reaches the server as a signed, argument-bound token) | Lets servers like SentryFlow bind approvals to a verified human decision instead of a second bearer token | Important |
| Mock-auth / dev mode for the web simulator | Test agent behaviour before building OAuth | Important |
| One authoritative protocol version in all MCP docs | Removes ambiguity between 2025-03-26 and 2025-11-25 | Nice-to-have |
| Local Inspector on Node 20 LTS | Lower setup cost | Nice-to-have |
