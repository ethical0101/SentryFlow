import { useState } from "react";
import { ChevronDown, ChevronRight, Cpu, Network, Server, ShieldCheck } from "lucide-react";
import { useSentry } from "../state";
import type { SentryMcpClient } from "../mcp/client";
import { Badge, Card, JsonBlock, KV } from "../components/ui";
import { clock } from "../lib/format";

export function System() {
  const s = useSentry();
  const h = s.health;
  const [openTool, setOpenTool] = useState<string | null>(null);
  const tools = s.agent?.tools ?? [];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid-3">
        <Card title={<span className="row"><Server size={15} /> Server</span>} actions={<Badge tone={h?.status === "ok" ? "allow" : "deny"}>{h?.status ?? "unknown"}</Badge>}>
          {h ? (
            <KV
              items={[
                ["Name", `${h.server.name} ${h.server.version}`],
                ["Uptime", `${Math.floor(h.server.uptimeSeconds / 60)} min`],
                ["Runtime", `Node ${h.server.node}`],
                ["Policy", <code key="p">{h.policy.version}</code>],
                ["Audit chain", h.audit.ok ? `verified (${h.audit.records} records)` : `BROKEN at #${h.audit.firstBrokenSeq}`],
              ]}
            />
          ) : (
            <p className="hint">Waiting for /health…</p>
          )}
        </Card>
        <Card title={<span className="row"><Network size={15} /> MCP endpoint</span>} actions={<Badge tone="info">{h?.mcp.protocolVersion ?? "—"}</Badge>}>
          {h && (
            <KV
              items={[
                ["Endpoint", <code key="e">{window.location.origin}{h.mcp.endpoint}</code>],
                ["Transport", h.mcp.transport],
                ["Spec version", h.mcp.protocolVersion],
                ["Open sessions", `agent ${h.mcp.sessions.agent} · approver ${h.mcp.sessions.approver}`],
                ["Auth", "Bearer token per role; 401 without WWW-Authenticate"],
              ]}
            />
          )}
        </Card>
        <Card title={<span className="row"><Cpu size={15} /> Planner</span>} actions={<Badge tone={h?.planner.effective === "ollama" ? "allow" : "amber"}>{h?.planner.effective ?? "—"}</Badge>}>
          {h && (
            <KV
              items={[
                ["Configured", h.planner.configured],
                ["Model", h.planner.model],
                ["Ollama", h.planner.ollama.reachable ? "reachable" : `unreachable${h.planner.ollama.error ? ` (${h.planner.ollama.error})` : ""}`],
                ["Model installed", h.planner.ollama.modelInstalled ? "yes" : "no"],
                ["Installed models", h.planner.ollama.models.join(", ") || "—"],
              ]}
            />
          )}
        </Card>
      </div>

      <div className="grid-2">
        {s.agent && <SessionCard c={s.agent} />}
        {s.approver && <SessionCard c={s.approver} />}
      </div>

      <Card title={`Tools discovered via tools/list (${tools.length})`} subtitle="Schemas and annotations exactly as advertised by the server">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Tool</th>
                <th>Description</th>
                <th>Hints</th>
              </tr>
            </thead>
            <tbody>
              {tools.flatMap((t) => [
                <tr key={t.name} className="clickable" onClick={() => setOpenTool(openTool === t.name ? null : t.name)} aria-expanded={openTool === t.name}>
                  <td>{openTool === t.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td className="dim" style={{ fontSize: 12.5 }}>
                    {t.description}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {t.annotations?.readOnlyHint && <Badge tone="muted">read-only</Badge>}
                      {t.annotations?.destructiveHint && <Badge tone="amber">destructive</Badge>}
                      {/approver only/.test(t.title ?? "") && <Badge tone="info">approver</Badge>}
                    </div>
                  </td>
                </tr>,
                openTool === t.name ? (
                  <tr key={`${t.name}-s`}>
                    <td />
                    <td colSpan={3}>
                      <JsonBlock value={{ inputSchema: t.inputSchema, annotations: t.annotations }} maxHeight={300} />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Live MCP traffic" subtitle="Every HTTP exchange made by this page's MCP clients (captured from the transport's fetch)">
        {s.traffic.length === 0 ? (
          <p className="hint">No traffic yet.</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Session</th>
                  <th>HTTP</th>
                  <th>JSON-RPC</th>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {s.traffic
                  .slice()
                  .reverse()
                  .map((t) => (
                    <tr key={t.id}>
                      <td className="muted">{t.id}</td>
                      <td className="mono">{clock(t.at)}</td>
                      <td>
                        <Badge tone={t.role === "approver" ? "amber" : "info"}>{t.role}</Badge>
                      </td>
                      <td className="mono">{t.httpMethod}</td>
                      <td className="mono">{t.rpcMethod}</td>
                      <td className="mono">{t.tool ?? ""}</td>
                      <td>
                        <Badge tone={t.status < 300 ? "allow" : t.status < 500 ? "amber" : "deny"}>{t.status}</Badge>
                      </td>
                      <td className="mono muted">{t.ms}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {h && (
        <div className="sim-banner">
          <ShieldCheck size={16} />
          <span>{h.simulation.notice}</span>
        </div>
      )}
    </div>
  );
}

function SessionCard({ c }: { c: SentryMcpClient }) {
  return (
    <Card title={`${c.role === "agent" ? "Agent" : "Approver (owner)"} session`} actions={<Badge tone={c.role === "agent" ? "info" : "amber"}>{c.role}</Badge>}>
      <KV
        items={[
          ["Session id", <code key="s">{c.sessionId ?? "—"}</code>],
          ["Negotiated protocol", <code key="p">{c.protocolVersion ?? "—"}</code>],
          ["Server", `${c.serverInfo?.name ?? "?"} ${c.serverInfo?.version ?? ""}`],
          ["Capabilities", <code key="c">{Object.keys(c.serverCapabilities ?? {}).join(", ")}</code>],
          ["Tools", String(c.tools.length)],
          ["Re-initializations", String(c.reconnects)],
        ]}
      />
      {c.instructions && <p className="hint" style={{ marginTop: 10 }}>Server instructions: {c.instructions}</p>}
    </Card>
  );
}
