import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "..");

/** Minimal .env loader (no dependency). Real environment variables take precedence. */
function loadDotEnv() {
  const file = resolve(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

export interface Config {
  host: string;
  port: number;
  allowedOrigins: string[];
  dataDir: string;
  policyFile: string;
  approvalTtlSeconds: number;
  planner: "ollama" | "rules";
  ollama: { baseUrl: string; model: string; timeoutMs: number };
  tokens: { agent: string; approver: string; generated: boolean };
  exposeDevCredentials: boolean;
  webDist: string;
}

const env = (k: string) => {
  const v = process.env[k];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};

function intEnv(k: string, def: number, min: number, max: number): number {
  const raw = env(k);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be an integer between ${min} and ${max}`);
  return n;
}

function resolveTokens(dataDir: string): Config["tokens"] {
  const agent = env("SENTRYFLOW_AGENT_TOKEN");
  const approver = env("SENTRYFLOW_APPROVER_TOKEN");
  if (agent && approver) {
    if (agent === approver) throw new Error("Agent and approver tokens must differ");
    return { agent, approver, generated: false };
  }
  // Generate once and persist to the git-ignored data dir so restarts keep working sessions.
  const file = resolve(dataDir, "dev-credentials.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { agentToken: string; approverToken: string };
    return { agent: agent ?? saved.agentToken, approver: approver ?? saved.approverToken, generated: true };
  }
  const gen = { agentToken: `sfa_${randomBytes(24).toString("base64url")}`, approverToken: `sfo_${randomBytes(24).toString("base64url")}` };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(gen, null, 2), { mode: 0o600 });
  return { agent: agent ?? gen.agentToken, approver: approver ?? gen.approverToken, generated: true };
}

export function loadConfig(): Config {
  loadDotEnv();
  const port = intEnv("SENTRYFLOW_PORT", 8787, 1, 65535);
  const dataDir = resolve(REPO_ROOT, env("SENTRYFLOW_DATA_DIR") ?? "data");
  const planner = env("SENTRYFLOW_PLANNER") ?? "ollama";
  if (planner !== "ollama" && planner !== "rules") throw new Error("SENTRYFLOW_PLANNER must be 'ollama' or 'rules'");
  const origins = env("SENTRYFLOW_ALLOWED_ORIGINS") ?? `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${port},http://127.0.0.1:${port}`;
  return {
    host: env("SENTRYFLOW_HOST") ?? "127.0.0.1",
    port,
    allowedOrigins: origins.split(",").map((o) => o.trim()).filter(Boolean),
    dataDir,
    policyFile: resolve(REPO_ROOT, env("SENTRYFLOW_POLICY_FILE") ?? resolve(SERVER_ROOT, "policy/default-policy.json")),
    approvalTtlSeconds: intEnv("SENTRYFLOW_APPROVAL_TTL_SECONDS", 300, 5, 86400),
    planner,
    ollama: {
      baseUrl: (env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
      model: env("OLLAMA_MODEL") ?? "qwen2.5:3b",
      timeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 45000, 1000, 600000),
    },
    tokens: resolveTokens(dataDir),
    exposeDevCredentials: (env("SENTRYFLOW_EXPOSE_DEV_CREDENTIALS") ?? "true") === "true",
    webDist: resolve(REPO_ROOT, "web/dist"),
  };
}
