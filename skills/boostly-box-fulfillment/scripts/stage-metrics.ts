import { performance } from "node:perf_hooks";

export type StageName =
  | "slack_parse"
  | "location_match"
  | "production_read"
  | "official_site_crawl"
  | "external_search"
  | "candidate_verification"
  | "branding_evidence"
  | "branding_judgment"
  | "plan_build"
  | "production_apply"
  | "artifact_generation";

export type StageMetric = {
  stage: StageName;
  started_at: string;
  duration_ms: number;
  counters: Record<string, number>;
  outcome: "ok" | "error";
  error_code?: string;
};

type ActiveStage = {
  startedAt: string;
  startedMs: number;
  counters: Record<string, number>;
};

export class StageRecorder {
  readonly #active = new Map<StageName, ActiveStage>();
  readonly #completed: StageMetric[] = [];

  start(stage: StageName): void {
    if (this.#active.has(stage)) throw new Error(`Stage already active: ${stage}`);
    this.#active.set(stage, {
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      counters: {},
    });
  }

  increment(stage: StageName, counter: string, amount = 1): void {
    if (!Number.isFinite(amount)) throw new Error(`Invalid counter amount for ${counter}`);
    const active = this.#active.get(stage);
    if (!active) throw new Error(`Cannot increment inactive stage: ${stage}`);
    active.counters[counter] = (active.counters[counter] ?? 0) + amount;
  }

  finish(stage: StageName, outcome: "ok" | "error" = "ok", errorCode?: string): StageMetric {
    const active = this.#active.get(stage);
    if (!active) throw new Error(`Cannot finish inactive stage: ${stage}`);
    this.#active.delete(stage);
    const metric: StageMetric = {
      stage,
      started_at: active.startedAt,
      duration_ms: Number((performance.now() - active.startedMs).toFixed(3)),
      counters: { ...active.counters },
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
    };
    this.#completed.push(metric);
    return metric;
  }

  async measure<T>(stage: StageName, operation: () => Promise<T>): Promise<T> {
    this.start(stage);
    try {
      const result = await operation();
      this.finish(stage);
      return result;
    } catch (error) {
      this.finish(stage, "error", error instanceof Error ? error.name : "unknown_error");
      throw error;
    }
  }

  snapshot(): { total_duration_ms: number; stages: StageMetric[] } {
    if (this.#active.size) {
      throw new Error(`Cannot snapshot active stages: ${[...this.#active.keys()].join(", ")}`);
    }
    return {
      total_duration_ms: Number(
        this.#completed.reduce((total, metric) => total + metric.duration_ms, 0).toFixed(3),
      ),
      stages: this.#completed.map((metric) => ({
        ...metric,
        counters: { ...metric.counters },
      })),
    };
  }
}
