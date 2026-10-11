import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/http/app.js";
import { DEMO_REQUEST, makeService } from "./helpers.js";

const TOKENS = { agent: "test-agent-token-0123456789", approver: "test-approver-token-0123456789" };
let base: string;
let httpServer: Server;
let closeApp: () => Promise<void>;
let ctx: ReturnType<typeof makeService>;

beforeAll(async () => {
  ctx = makeService();
  const { app, close } = createApp(ctx.svc, {
    tokens: TOKENS,
    allowedOrigins: ["http://localhost:5173"],
    exposeDevCredentials: true,
    planner: { provider: "rules", ollama: { baseUrl: "http://127.0.0.1:1", model: "none", timeoutMs: 100 } },
  });
  closeApp = close;
  await new Promise<void>((r) => {
    httpServer = app.listen(0, "127.0.0.1", () => r());
  });
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeApp();
  await new Promise((r) => httpServer.close(r));
});

async function connect(token: string) {
  const client = new Client({ name: "sentryflow-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport };
}

type Structured = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent as Structured, text: (r.content as { text: string }[])[0]?.text ?? "" };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("MCP over Streamable HTTP", () => {
  it("initializes with protocol 2025-11-25 and issues a session id", async () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    const res = await post(INIT, { authorization: `Bearer ${TOKENS.agent}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    const text = await res.text();
    const json = JSON.parse(text.includes("data:") ? text.split("data:")[1]!.trim() : text);
    expect(json.result.protocolVersion).toBe("2025-11-25");
    expect(json.result.serverInfo.name).toBe("sentryflow");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("lists tools with precise schemas and annotations", async () => {
    const { client } = await connect(TOKENS.agent);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "sentryflow_plan_request",
        "sentryflow_evaluate_action",
        "sentryflow_get_device_state",
        "sentryflow_resolve_approval",
        "sentryflow_execute_action",
        "sentryflow_execute_plan",
        "sentryflow_get_receipt",
        "sentryflow_get_audit_log",
      ]),
    );
    const plan = tools.find((t) => t.name === "sentryflow_plan_request")!;
    expect(plan.inputSchema.required).toEqual(["request"]);
    expect(tools.find((t) => t.name === "sentryflow_execute_action")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "sentryflow_get_device_state")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("runs the full lifecycle over MCP with separated agent and approver roles", async () => {
    const agent = (await connect(TOKENS.agent)).client;
    const owner = (await connect(TOKENS.approver)).client;

    const planned = await call(agent, "sentryflow_plan_request", { request: DEMO_REQUEST, planner: "rules" });
    expect(planned.isError).toBe(false);
    expect(planned.text).toMatch(/need your approval/);
    const plan = planned.data.plan;
    const purchase = plan.actions.find((a: Structured) => a.tool === "purchase_item");

    const exec = await call(agent, "sentryflow_execute_plan", { planId: plan.planId });
    expect(exec.data.summary.succeeded).toHaveLength(3);
    const state = await call(agent, "sentryflow_get_device_state");
    expect(state.data.household.thermostat.mode).toBe("eco");

    // The agent cannot approve its own action.
    const selfApprove = await call(agent, "sentryflow_resolve_approval", { planId: plan.planId, actionId: purchase.actionId, decision: "approve", argsHash: purchase.argsHash });
    expect(selfApprove).toMatchObject({ isError: true, data: { error: { code: "FORBIDDEN" } } });

    const pending = await call(owner, "sentryflow_list_pending_approvals");
    expect(pending.data.pending.map((p: Structured) => p.actionId)).toContain(purchase.actionId);

    const approved = await call(owner, "sentryflow_resolve_approval", { planId: plan.planId, actionId: purchase.actionId, decision: "approve", argsHash: purchase.argsHash });
    expect(approved.data.action.approval.status).toBe("APPROVED");

    const ran = await call(agent, "sentryflow_execute_action", { planId: plan.planId, actionId: purchase.actionId });
    expect(ran.data.action.execution.status).toBe("SUCCEEDED");

    const again = await call(agent, "sentryflow_execute_action", { planId: plan.planId, actionId: purchase.actionId });
    expect(again).toMatchObject({ isError: true, data: { error: { code: "DUPLICATE_EXECUTION" } } });

    const receipt = await call(agent, "sentryflow_get_receipt", { planId: plan.planId });
    expect(receipt.data.receipt.summary).toMatchObject({ succeeded: 4, denied: 1 });
    expect(receipt.data.receipt.integrity.ok).toBe(true);

    const audit = await call(owner, "sentryflow_get_audit_log", { planId: plan.planId });
    expect(audit.data.records.some((r: Structured) => r.type === "AUTHORIZATION_FAILED")).toBe(false); // logged under "system"
    expect(ctx.svc.auditLog({}).records.some((r) => r.type === "AUTHORIZATION_FAILED" && r.data.attempted === "sentryflow_resolve_approval")).toBe(true);

    await agent.close();
    await owner.close();
  });

  it("validates tool input schemas", async () => {
    const { client } = await connect(TOKENS.agent);
    const bad = await client.callTool({ name: "sentryflow_get_plan", arguments: { planId: "../../etc/passwd" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(bad.isError).toBe(true);
    const empty = await client.callTool({ name: "sentryflow_plan_request", arguments: { request: "" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(empty.isError).toBe(true);
    const unknown = await client.callTool({ name: "sentryflow_launch_rockets", arguments: {} }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(unknown.isError).toBe(true);
    await client.close();
  });

  it("rejects prototype-tampering keys in tool arguments", async () => {
    const { client } = await connect(TOKENS.agent);
    const args = JSON.parse('{"doorId":"front_door","__proto__":{"polluted":true}}');
    const r = await client
      .callTool({ name: "sentryflow_evaluate_action", arguments: { tool: "lock_door", args } })
      .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    expect(r.isError).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await client.close();
  });

  it("agent cannot reset the simulation or inject faults", async () => {
    const { client } = await connect(TOKENS.agent);
    expect((await call(client, "sentryflow_reset_environment", { clearPlans: true })).data.error.code).toBe("FORBIDDEN");
    expect((await call(client, "sentryflow_set_device_fault", { deviceId: "porch", offline: true })).data.error.code).toBe("FORBIDDEN");
    await client.close();
  });
});

describe("HTTP-level protections", () => {
  it("401 without (or with a wrong) bearer token, and no WWW-Authenticate header", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${TOKENS.agent}` }] as Record<string, string>[]) {
      const res = await post(INIT, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("403 for a disallowed Origin (DNS rebinding protection)", async () => {
    const res = await post(INIT, { authorization: `Bearer ${TOKENS.agent}`, origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("400 for non-initialize requests without a session; 404 for unknown sessions", async () => {
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    expect((await post(list, { authorization: `Bearer ${TOKENS.agent}` })).status).toBe(400);
    const res = await post(list, { authorization: `Bearer ${TOKENS.agent}`, "mcp-session-id": "00000000-0000-0000-0000-000000000000", "mcp-protocol-version": "2025-11-25" });
    expect(res.status).toBe(404);
  });

  it("a session cannot be used with the other role's token", async () => {
    const res = await post(INIT, { authorization: `Bearer ${TOKENS.agent}` });
    const sid = res.headers.get("mcp-session-id")!;
    await res.text();
    const hijack = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { authorization: `Bearer ${TOKENS.approver}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-11-25" });
    expect(hijack.status).toBe(403);
  });

  it("malformed JSON yields a JSON-RPC parse error", async () => {
    const res = await post("{not json", { authorization: `Bearer ${TOKENS.agent}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects oversized request bodies with 413", async () => {
    const big = { ...INIT, params: { ...INIT.params, clientInfo: { name: "x".repeat(70_000), version: "1" } } };
    const res = await post(big, { authorization: `Bearer ${TOKENS.agent}` });
    expect(res.status).toBe(413);
  });

  it("rejects an unsupported protocol version header on an established session", async () => {
    const init = await post(INIT, { authorization: `Bearer ${TOKENS.agent}` });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { authorization: `Bearer ${TOKENS.agent}`, "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" });
    expect(res.status).toBe(400);
  });

  it("serves /health and loopback-only dev credentials", async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h).toMatchObject({ status: "ok", mcp: { protocolVersion: "2025-11-25", transport: "streamable-http" } });
    const creds = await fetch(`${base}/api/dev/credentials`);
    expect(creds.status).toBe(200);
    const bad = await fetch(`${base}/api/dev/credentials`, { headers: { origin: "http://evil.example" } });
    expect(bad.status).toBe(403);
  });
});
