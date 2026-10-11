import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Principal, Role } from "../domain/types.js";
import { createMcpServer, SERVER_INFO } from "../mcp/server.js";
import { ollamaStatus } from "../planner/ollama.js";
import type { SentryFlowService } from "../service/sentryflow.js";

export interface AppOptions {
  tokens: { agent: string; approver: string };
  allowedOrigins: string[];
  exposeDevCredentials: boolean;
  planner: { provider: "ollama" | "rules"; ollama: { baseUrl: string; model: string; timeoutMs: number } };
  webDist?: string;
  maxSessions?: number;
  sessionIdleMs?: number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  principal: Principal;
  createdAt: number;
  lastSeen: number;
}

const startedAt = Date.now();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

const isLoopback = (addr: string | undefined) => !!addr && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr);

export function createApp(svc: SentryFlowService, opts: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  const sessions = new Map<string, Session>();
  const maxSessions = opts.maxSessions ?? 100;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;

  const status = async () => {
    const ollama = opts.planner.provider === "ollama" ? await ollamaStatus(opts.planner.ollama) : null;
    const byRole = (r: Role) => [...sessions.values()].filter((s) => s.principal.role === r).length;
    return {
      server: { ...SERVER_INFO, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), node: process.version },
      mcp: { endpoint: "/mcp", transport: "streamable-http", protocolVersion: LATEST_PROTOCOL_VERSION, sessions: { agent: byRole("agent"), approver: byRole("approver") } },
      planner: {
        configured: opts.planner.provider,
        model: opts.planner.ollama.model,
        ollama: ollama ?? { reachable: false, modelInstalled: false, models: [], error: "disabled (SENTRYFLOW_PLANNER=rules)" },
        effective: opts.planner.provider === "ollama" && ollama?.reachable && ollama.modelInstalled ? "ollama" : "rules (fallback)",
      },
      policy: { version: svc.policy.version, rules: svc.policy.doc.rules.length, approvalTtlSeconds: svc.approvalTtlSeconds },
      audit: svc.auditLog({ limit: 1 }).integrity,
      simulation: { notice: "All devices are simulated. No real Alexa, Ring or other device is connected." },
    };
  };

  // ── Security headers & Origin validation (DNS-rebinding protection) ──
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  const originCheck = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && !opts.allowedOrigins.includes(origin)) {
      svc.recordAuthFailure("unknown", { reason: "origin not allowed", origin: origin.slice(0, 100), path: req.path });
      return jsonRpcError(res, 403, -32001, "Forbidden: origin not allowed");
    }
    next();
  };

  // ── Health ──
  app.get("/health", async (_req, res) => {
    const s = await status();
    res.json({ status: s.audit.ok ? "ok" : "degraded", ...s });
  });

  // ── Dev credentials for the local web console (loopback only) ──
  app.get("/api/dev/credentials", originCheck, (req, res) => {
    if (!opts.exposeDevCredentials || !isLoopback(req.socket.remoteAddress)) return res.status(404).json({ error: "Not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      agentToken: opts.tokens.agent,
      approverToken: opts.tokens.approver,
      notice: "Local demo only: both roles are issued to this browser. In production the approver credential belongs on the owner's own device.",
    });
  });

  // ── MCP over Streamable HTTP ──
  const authenticate = (req: Request, res: Response): Principal | null => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const token = m?.[1];
    let principal: Principal | null = null;
    if (token && safeEqual(token, opts.tokens.agent)) principal = { role: "agent", id: "agent" };
    else if (token && safeEqual(token, opts.tokens.approver)) principal = { role: "approver", id: "owner" };
    if (!principal) {
      // Per the Alexa+ MCP checklist: 401 without a WWW-Authenticate header.
      svc.recordAuthFailure("unknown", { reason: token ? "invalid token" : "missing bearer token", path: req.path });
      jsonRpcError(res, 401, -32001, "Unauthorized");
    }
    return principal;
  };

  app.all("/mcp", originCheck, express.json({ limit: "64kb" }), async (req, res) => {
    const principal = authenticate(req, res);
    if (!principal) return;
    try {
      const sid = req.header("mcp-session-id");
      if (sid) {
        const session = sessions.get(sid);
        if (!session) return jsonRpcError(res, 404, -32001, "Session not found");
        if (session.principal.role !== principal.role) {
          svc.recordAuthFailure(principal.id, { reason: "token does not own session", sessionRole: session.principal.role });
          return jsonRpcError(res, 403, -32001, "Forbidden: session belongs to a different principal");
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (req.method === "POST" && isInitializeRequest(req.body)) {
        if (sessions.size >= maxSessions) return jsonRpcError(res, 503, -32000, "Too many sessions");
        const server = createMcpServer(svc, principal, status);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, principal, createdAt: Date.now(), lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      jsonRpcError(res, 400, -32000, "Bad Request: missing mcp-session-id (send initialize first)");
    } catch (e) {
      console.error("[sentryflow] /mcp error:", e);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    }
  });

  // Malformed JSON bodies → JSON-RPC parse error rather than an HTML page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed")
      return jsonRpcError(res, 400, -32700, "Parse error");
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large")
      return jsonRpcError(res, 413, -32600, "Request too large");
    next(err);
  });

  // ── Static web client (production build) ──
  if (opts.webDist && existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist, { index: "index.html" }));
    app.get(/^\/(?!mcp|api|health).*/, (_req, res) => res.sendFile(resolve(opts.webDist!, "index.html")));
  }

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void s.transport.close().finally(() => sessions.delete(id));
  }, 60_000);
  sweeper.unref();

  return {
    app,
    sessions,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
      sessions.clear();
    },
  };
}
