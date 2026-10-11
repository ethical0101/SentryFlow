/**
 * End-to-end smoke test against a RUNNING SentryFlow server, using the official MCP SDK client over
 * Streamable HTTP. Prints each step and exits non-zero on the first failed expectation.
 *
 *   npm run smoke                       # uses http://127.0.0.1:8787 and data/dev-credentials.json
 *   SENTRYFLOW_URL=http://host:port npm run smoke
 *   SMOKE_PLANNER=ollama npm run smoke  # exercise the local model instead of the rule planner
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REPO_ROOT } from "../src/config.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const base = process.env.SENTRYFLOW_URL ?? "http://127.0.0.1:8787";
const planner = process.env.SMOKE_PLANNER ?? "rules";
const creds = (() => {
  if (process.env.SENTRYFLOW_AGENT_TOKEN && process.env.SENTRYFLOW_APPROVER_TOKEN)
    return { agentToken: process.env.SENTRYFLOW_AGENT_TOKEN, approverToken: process.env.SENTRYFLOW_APPROVER_TOKEN };
  return JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.SENTRYFLOW_DATA_DIR ?? "data", "dev-credentials.json"), "utf8")) as { agentToken: string; approverToken: string };
})();

let step = 0;
function check(cond: unknown, label: string, detail?: unknown) {
  step++;
  if (!cond) {
    console.error(`✗ ${step}. ${label}`, detail !== undefined ? JSON.stringify(detail, null, 2).slice(0, 2000) : "");
    process.exit(1);
  }
  console.log(`✓ ${step}. ${label}`);
}

async function connect(token: string, name: string) {
  const traffic: string[] = [];
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
      traffic.push(`${init?.method ?? "GET"} ${body?.method ?? ""} → ${res.status}`);
      return res;
    },
  });
  await client.connect(transport);
  return { client, transport, traffic };
}

async function call(client: Client, name: string, args: Json = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent as Json, text: (r.content as { text: string }[])[0]?.text ?? "" };
}

const health = (await (await fetch(`${base}/health`)).json()) as Json;
check(health.status === "ok", `GET /health → ${health.status}; protocol ${health.mcp?.protocolVersion}; planner ${health.planner?.effective}`, health);

const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(unauth.status === 401 && !unauth.headers.get("www-authenticate"), "Unauthenticated /mcp → 401 without WWW-Authenticate");

const agent = await connect(creds.agentToken, "smoke-agent");
const owner = await connect(creds.approverToken, "smoke-owner");
check(agent.transport.sessionId, `initialize → session ${agent.transport.sessionId}, server ${agent.client.getServerVersion()?.name}@${agent.client.getServerVersion()?.version}`);

const { tools } = await agent.client.listTools();
check(tools.length >= 15, `tools/list → ${tools.length} tools`);

await call(owner.client, "sentryflow_reset_environment", { clearPlans: false });
const request =
  "I'm leaving for college. Turn off the lights, set the thermostat to eco mode, and prepare the house. " +
  "Order 2 air filters and turn off the backyard camera. Never unlock a door, disable security, or make purchases without explicit approval.";
const t0 = Date.now();
const planned = await call(agent.client, "sentryflow_plan_request", { request, planner });
const plan = planned.data.plan as Json;
check(!planned.isError && plan.actions.length > 0, `plan_request (${plan.planner.provider}${plan.planner.fallbackReason ? `, fallback: ${plan.planner.fallbackReason}` : ""}, ${Date.now() - t0} ms) → ${plan.actions.length} actions`);
console.log(`    “${planned.text}”`);
for (const a of plan.actions) console.log(`    - ${a.tool} ${JSON.stringify(a.args)} → ${a.policy.decision} (${a.policy.ruleId})`);

const purchase = plan.actions.find((a: Json) => a.tool === "purchase_item");
const denied = plan.actions.find((a: Json) => a.policy.decision === "DENY");
check(purchase?.policy.decision === "REQUIRE_APPROVAL", "purchase requires approval", purchase);

const exec = await call(agent.client, "sentryflow_execute_plan", { planId: plan.planId });
check(exec.data.summary.succeeded.length > 0, `execute_plan → ${exec.text}`);
const state = (await call(agent.client, "sentryflow_get_device_state")).data.household as Json;
check(state.thermostat.mode === "eco" && Object.values(state.lights as Json).every((l: Json) => !l.on), "simulated state changed: lights off, thermostat eco");
check(state.orders.length === 0, "no order placed before approval");

const self = await call(agent.client, "sentryflow_resolve_approval", { planId: plan.planId, actionId: purchase.actionId, decision: "approve", argsHash: purchase.argsHash });
check(self.isError && self.data.error.code === "FORBIDDEN", "agent cannot approve its own action → FORBIDDEN");

const purchaseNow = (exec.data.plan.actions as Json[]).find((a) => a.actionId === purchase.actionId)!;
if (purchaseNow.execution.status === "SKIPPED") {
  // Possible with a model-generated plan: the model made the purchase depend on a denied action.
  const refused = await call(owner.client, "sentryflow_resolve_approval", { planId: plan.planId, actionId: purchase.actionId, decision: "approve", argsHash: purchase.argsHash });
  check(refused.data.error?.code === "CONFLICT", `purchase was skipped (${purchaseNow.execution.blockedReason}); approving it is refused → CONFLICT`);
} else {
  const approved = await call(owner.client, "sentryflow_resolve_approval", { planId: plan.planId, actionId: purchase.actionId, decision: "approve", argsHash: purchase.argsHash, note: "smoke test" });
  check(approved.data.action?.approval.status === "APPROVED", `owner approves → ${approved.text}`);
  const ran = await call(agent.client, "sentryflow_execute_action", { planId: plan.planId, actionId: purchase.actionId });
  check(ran.data.action?.execution.status === "SUCCEEDED", `execute approved action → ${ran.text}`);
  const replay = await call(agent.client, "sentryflow_execute_action", { planId: plan.planId, actionId: purchase.actionId });
  check(replay.data.error?.code === "DUPLICATE_EXECUTION", "re-execution rejected → DUPLICATE_EXECUTION");
}

if (denied) {
  const d = await call(agent.client, "sentryflow_execute_action", { planId: plan.planId, actionId: denied.actionId });
  check(d.data.action?.execution.status === "BLOCKED", `denied action stays blocked → ${d.text}`);
}

const receipt = (await call(agent.client, "sentryflow_get_receipt", { planId: plan.planId })).data.receipt as Json;
check(receipt.integrity.ok, `receipt: ${JSON.stringify(receipt.summary)}; audit chain verified over ${receipt.integrity.records} records`);
console.log(receipt.text.split("\n").map((l: string) => `    ${l}`).join("\n"));

console.log(`\nAgent session traffic:\n  ${agent.traffic.join("\n  ")}`);
await agent.client.close();
await owner.client.close();
console.log(`\nSmoke test passed (${step} checks).`);
