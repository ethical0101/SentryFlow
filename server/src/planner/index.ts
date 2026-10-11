import type { PlannerInfo } from "../domain/types.js";
import { normalizeProposals, type Proposal } from "./normalize.js";
import { ollamaPlan, type OllamaConfig } from "./ollama.js";
import { planWithRules } from "./rules.js";

export type PlannerMode = "auto" | "ollama" | "rules";

export interface PlannerResult {
  proposals: Proposal[];
  info: PlannerInfo;
}

/** Raw model call; injectable so tests can feed malformed output without a running model. */
export type ModelCall = (request: string) => Promise<unknown>;

export class Planner {
  constructor(
    private readonly defaultProvider: "ollama" | "rules",
    private readonly ollama: OllamaConfig,
    private readonly modelCall: ModelCall = (r) => ollamaPlan(ollama, r),
  ) {}

  get provider() {
    return this.defaultProvider;
  }
  get model() {
    return this.ollama.model;
  }

  async plan(request: string, mode: PlannerMode = "auto"): Promise<PlannerResult> {
    const started = Date.now();
    const useModel = mode === "ollama" || (mode === "auto" && this.defaultProvider === "ollama");
    if (useModel) {
      try {
        const raw = await this.modelCall(request);
        const { proposals, dropped } = normalizeProposals(raw);
        if (proposals.length === 0 && dropped.length === 0) throw new Error("Model returned no actions");
        return {
          proposals,
          info: { provider: "ollama", model: this.ollama.model, requestedProvider: mode, latencyMs: Date.now() - started, droppedProposals: dropped },
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return this.rules(request, mode, started, reason.slice(0, 300));
      }
    }
    return this.rules(request, mode, started);
  }

  private rules(request: string, mode: PlannerMode, started: number, fallbackReason?: string): PlannerResult {
    return {
      proposals: planWithRules(request),
      info: { provider: "rules", requestedProvider: mode, fallbackReason, latencyMs: Date.now() - started, droppedProposals: [] },
    };
  }
}
