// Self-healing surfaces of the engine client: the operator health
// digest, patch candidates, and self-healing scans. Method group merged
// into `EngineClient` by `../engine-client.ts`.

import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";

// Operator health digest — mirrors apps/engine/src/operator/health-digest.ts.
export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";
export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  /**
   * How many of these runs the scheduler started. `origin` collapses to
   * "mixed" once a group holds more than one kind, so it cannot answer this.
   */
  scheduled_count: number;
  last_seen: string;
  /**
   * The workflow's most recent clean run on its own schedule, when that run is
   * newer than the group's last failure; null while the cause is live.
   */
  resolved_at: string | null;
  cause: string;
  guidance: string | null;
}
export interface DigestPatch {
  id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  classification: "safe" | "unsafe";
  summary: string;
}
export type RiskSeverity = "warn" | "critical";
export interface RiskSignal {
  kind: string;
  severity: RiskSeverity;
  headline: string;
  detail: string;
  metric: string;
  value: number;
  threshold: number;
}
/** One thing that needs the reader now — mirrors `AttentionItem` (attention.v1). */
export interface AttentionItem {
  id: string;
  class: "stopped" | "failing" | "decide";
  severity: "critical" | "urgent";
  kind: string;
  subject: { kind: string; id: string; name: string | null } | null;
  reason: string;
  counts: { patches?: number; failures?: number; skills?: number };
  since: string | null;
  deadline: string | null;
  detail: string | null;
  actions: Array<{ verb: string; href: string; primary: boolean; permission: string }>;
}
export interface DigestAttention {
  schema_version: "attention.v1";
  sources: Record<string, "answered" | "failed" | "not_permitted">;
  items: AttentionItem[];
}
export interface OperatorHealthDigest {
  generated_at: string;
  window_hours: number;
  headline: string;
  failure_groups: DigestFailureGroup[];
  /** `open`: exact count of proposed AND reviewable candidates; `items` is capped. */
  patch_candidates: { open: number; items: DigestPatch[] };
  risk: RiskSignal[];
  /** What needs the reader now; `headline` and `all_clear` are rendered from it. */
  attention: DigestAttention;
  rendered: string;
  all_clear: boolean;
}

export const selfHealingMethods = {
  // -------------------- Operator --------------------
  /**
   * Deterministic operator health digest — failed runs grouped by root
   * cause + tagged by origin, plus open self-healing fixes. The REPL
   * renders this as a colored first assistant turn at startup.
   */
  getOperatorHealthDigest(
    this: EngineClient,
    query: { window_hours?: number } = {},
  ): Promise<OperatorHealthDigest> {
    return this.request(
      "GET",
      "/v1/operator/health-digest",
      undefined,
      query,
    ) as Promise<OperatorHealthDigest>;
  },

  // -------------------- Patch Candidates --------------------
  listPatchCandidates(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/patch-candidates", undefined, query);
  },
  getPatchCandidate(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/patch-candidates/${encodeURIComponent(id)}`);
  },
  async approvePatchCandidate(
    this: EngineClient,
    id: string,
    expected_review_digest: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/patch-candidates/${encodeURIComponent(id)}/approve`,
      { expected_review_digest },
    );
    if (
      result.applied !== true ||
      typeof result.workflow_version_id !== "string" ||
      !result.workflow_version_id
    ) {
      throw new EngineError(409, {
        code: "patch_not_applicable",
        message: "The repair was not applied. Reload the candidate preview before approving.",
      });
    }
    return result;
  },
  rejectPatchCandidate(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/patch-candidates/${encodeURIComponent(id)}/reject`, body);
  },

  // -------------------- Self-Healing Scans --------------------
  triggerSelfHealingScan(
    this: EngineClient,
    body: { workflow_id?: string; connector_id?: string } = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const extraHeaders = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request("POST", "/v1/self-healing/scans", body, undefined, undefined, extraHeaders);
  },
  listSelfHealingScans(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/self-healing/scans", undefined, query);
  },
  getSelfHealingScan(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/self-healing/scans/${encodeURIComponent(id)}`);
  },
};
