import { loadConfig } from "./config.js";
import { buildService } from "./bootstrap.js";
import { createApp } from "./http/app.js";
import { ollamaStatus } from "./planner/ollama.js";

const cfg = loadConfig();
const svc = await buildService(cfg);
const { app, close } = createApp(svc, {
  tokens: cfg.tokens,
  allowedOrigins: cfg.allowedOrigins,
  exposeDevCredentials: cfg.exposeDevCredentials,
  planner: { provider: cfg.planner, ollama: cfg.ollama },
  webDist: cfg.webDist,
});

const integrity = svc.auditLog({ limit: 1 }).integrity;
const httpServer = app.listen(cfg.port, cfg.host, async () => {
  const ollama = cfg.planner === "ollama" ? await ollamaStatus(cfg.ollama) : null;
  console.log(`SentryFlow MCP server listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  MCP endpoint   : http://${cfg.host}:${cfg.port}/mcp  (Streamable HTTP)`);
  console.log(`  Health         : http://${cfg.host}:${cfg.port}/health`);
  console.log(`  Policy         : ${svc.policy.version}`);
  console.log(`  Planner        : ${cfg.planner}${ollama ? ` (${cfg.ollama.model}: ${ollama.reachable ? (ollama.modelInstalled ? "ready" : "model not installed → fallback") : "Ollama unreachable → fallback"})` : ""}`);
  console.log(`  Audit chain    : ${integrity.ok ? "verified" : `BROKEN at #${integrity.firstBrokenSeq}`} (${integrity.records} records)`);
  console.log(`  Credentials    : ${cfg.tokens.generated ? "generated → data/dev-credentials.json" : "from environment"}`);
});

const shutdown = async () => {
  await close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
