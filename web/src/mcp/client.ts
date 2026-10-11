import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type Role = "agent" | "approver";

/** One HTTP exchange on the MCP endpoint, captured from the real transport. */
export interface TrafficEntry {
  id: number;
  role: Role;
  at: string;
  httpMethod: string;
  rpcMethod: string;
  tool?: string;
  status: number;
  ms: number;
  sessionId?: string;
  isError?: boolean;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (e: TrafficEntry) => void;
let seq = 0;

/**
 * A role-bound MCP client using the official SDK over Streamable HTTP. All UI data comes through
 * `callTool`; there is no side channel to the server besides /health and the dev credential bootstrap.
 */
export class SentryMcpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Tool[] = [];
  reconnects = 0;
  private reconnecting: Promise<void> | null = null;

  constructor(
    readonly role: Role,
    private readonly token: string,
    private readonly onTraffic: Listener,
  ) {
    [this.client, this.transport] = this.build();
  }

  private build(): [Client, StreamableHTTPClientTransport] {
    const { role, token, onTraffic } = this;
    const client = new Client({ name: `sentryflow-web-${role}`, version: "1.0.0" });
    const transport: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(new URL("/mcp", window.location.origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => {
        const started = performance.now();
        let rpcMethod = init?.method === "GET" ? "(SSE stream)" : init?.method === "DELETE" ? "(end session)" : "";
        let tool: string | undefined;
        if (typeof init?.body === "string") {
          try {
            const body = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
            rpcMethod = body.method ?? "(response)";
            tool = body.method === "tools/call" ? body.params?.name : undefined;
          } catch {
            rpcMethod = "(unparsed)";
          }
        }
        const res = await fetch(url, init);
        onTraffic({
          id: ++seq,
          role,
          at: new Date().toISOString(),
          httpMethod: init?.method ?? "GET",
          rpcMethod,
          tool,
          status: res.status,
          ms: Math.round(performance.now() - started),
          sessionId: res.headers.get("mcp-session-id") ?? transport.sessionId,
        });
        return res;
      },
    });
    return [client, transport];
  }

  async connect() {
    await this.client.connect(this.transport);
    this.tools = (await this.client.listTools()).tools;
  }

  /**
   * Per the MCP spec, a 404 for a known session id means the session is gone (e.g. the server
   * restarted) and the client must initialize a new one. Single-flight: concurrent callers share one
   * reconnect, and the new session is swapped in only after it is fully initialized.
   */
  private reconnect(stale: Client): Promise<void> {
    if (this.client !== stale) return this.reconnecting ?? Promise.resolve();
    this.reconnecting ??= (async () => {
      const [client, transport] = this.build();
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      void stale.close().catch(() => undefined);
      this.client = client;
      this.transport = transport;
      this.tools = tools;
      this.reconnects++;
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  get sessionId() {
    return this.transport.sessionId;
  }

  get protocolVersion() {
    return this.transport.protocolVersion;
  }

  get serverInfo() {
    return this.client.getServerVersion();
  }

  get serverCapabilities() {
    return this.client.getServerCapabilities();
  }

  get instructions() {
    return this.client.getInstructions();
  }

  /** Calls a tool and returns its structuredContent, throwing ToolError for tool-level errors. */
  async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T & { _text: string }> {
    if (this.reconnecting) await this.reconnecting;
    const used = this.client;
    let r;
    try {
      r = await used.callTool({ name, arguments: args });
    } catch (e) {
      // Only a lost session is retried: the request never reached a live session, so nothing ran.
      if (!/Session not found|HTTP 404/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await this.reconnect(used);
      r = await this.client.callTool({ name, arguments: args });
    }
    const text = (r.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "";
    const data = (r.structuredContent ?? {}) as Record<string, unknown>;
    if (r.isError) {
      const err = data.error as { code?: string; message?: string } | undefined;
      throw new ToolError(err?.code ?? "ERROR", err?.message ?? text ?? "Tool error");
    }
    return { ...(data as T), _text: text };
  }

  async close() {
    try {
      await this.transport.terminateSession();
    } catch {
      /* server may already be gone */
    }
    await this.client.close();
  }
}

export interface Credentials {
  agentToken: string;
  approverToken: string;
}

export async function loadDevCredentials(): Promise<Credentials | null> {
  try {
    const res = await fetch("/api/dev/credentials", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Credentials;
  } catch {
    return null;
  }
}
