import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "../domain/canonical.js";

export type AuditType =
  | "SERVER_STARTED"
  | "REQUEST_RECEIVED"
  | "PLAN_CREATED"
  | "PLANNER_FALLBACK"
  | "POLICY_EVALUATED"
  | "ACTION_UPDATED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_INVALIDATED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CONSUMED"
  | "APPROVAL_WITHDRAWN"
  | "APPROVAL_DENIED_ATTEMPT"
  | "EXECUTION_STARTED"
  | "EXECUTION_SUCCEEDED"
  | "EXECUTION_FAILED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_SKIPPED"
  | "DUPLICATE_EXECUTION_REJECTED"
  | "ENVIRONMENT_RESET"
  | "DEVICE_FAULT_CHANGED"
  | "AUTHORIZATION_FAILED";

export interface AuditRecord {
  seq: number;
  ts: string;
  type: AuditType;
  correlationId: string;
  actionId?: string;
  actor: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  records: number;
  headHash: string;
  firstBrokenSeq?: number;
  problem?: string;
}

const GENESIS = "0".repeat(64);

function hashRecord(r: Omit<AuditRecord, "hash">): string {
  return sha256(r.prevHash + canonicalJson({ ...r, prevHash: undefined }));
}

/**
 * Append-only, hash-chained audit log stored as JSON Lines.
 *
 * Integrity, not secrecy or tamper-proofing: anyone who can write the file can recompute the whole
 * chain. The chain detects truncation-in-the-middle, edits and reordering by someone who does not
 * rewrite every subsequent record. See docs/THREAT_MODEL.md.
 */
export class AuditLog {
  private records: AuditRecord[] = [];

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      this.records = lines.map((l, i) => {
        try {
          return JSON.parse(l) as AuditRecord;
        } catch {
          // Keep a placeholder so verify() reports the exact position of corruption.
          return { seq: i + 1, ts: "", type: "SERVER_STARTED", correlationId: "corrupt", actor: "?", data: { corruptLine: l.slice(0, 200) }, prevHash: "", hash: "" };
        }
      });
    }
  }

  append(entry: { type: AuditType; correlationId: string; actionId?: string; actor: string; data?: Record<string, unknown>; ts: Date }): AuditRecord {
    const last = this.records.at(-1);
    const base: Omit<AuditRecord, "hash"> = {
      seq: (last?.seq ?? 0) + 1,
      ts: entry.ts.toISOString(),
      type: entry.type,
      correlationId: entry.correlationId,
      ...(entry.actionId ? { actionId: entry.actionId } : {}),
      actor: entry.actor,
      data: entry.data ?? {},
      prevHash: last?.hash ?? GENESIS,
    };
    const rec: AuditRecord = { ...base, hash: hashRecord(base) };
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(rec) + "\n");
    }
    this.records.push(rec);
    return rec;
  }

  list(filter: { correlationId?: string; limit?: number } = {}): AuditRecord[] {
    const rows = filter.correlationId ? this.records.filter((r) => r.correlationId === filter.correlationId) : this.records;
    return structuredClone(filter.limit ? rows.slice(-filter.limit) : rows);
  }

  verify(): VerifyResult {
    let prev = GENESIS;
    for (const [i, r] of this.records.entries()) {
      if (r.seq !== i + 1) return { ok: false, records: this.records.length, headHash: prev, firstBrokenSeq: i + 1, problem: "sequence gap or reorder" };
      if (r.prevHash !== prev) return { ok: false, records: this.records.length, headHash: prev, firstBrokenSeq: r.seq, problem: "prevHash does not match previous record" };
      const { hash, ...rest } = r;
      if (hashRecord(rest) !== hash) return { ok: false, records: this.records.length, headHash: prev, firstBrokenSeq: r.seq, problem: "record contents do not match its hash" };
      prev = hash;
    }
    return { ok: true, records: this.records.length, headHash: prev };
  }
}
