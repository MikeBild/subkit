import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";
export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  scheduled_count: number;
  last_seen: string;
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
  patch_candidates: { open: number; items: DigestPatch[] };
  risk: RiskSignal[];
  attention: DigestAttention;
  rendered: string;
  all_clear: boolean;
}

export const selfHealingMethods = {
  async getOperatorHealthDigest(
    this: EngineClient,
    query: { window_hours?: number } = {},
  ): Promise<OperatorHealthDigest> {
    const { data } = await this.api.GET("/v1/operator/health-digest", {
      params: { query: query as ApiQuery<"/v1/operator/health-digest", "get"> },
    });
    return data as OperatorHealthDigest;
  },

  async listPatchCandidates(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/patch-candidates", {
      params: { query: query as ApiQuery<"/v1/patch-candidates", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async getPatchCandidate(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/patch-candidates/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async approvePatchCandidate(
    this: EngineClient,
    id: string,
    expected_review_digest: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/patch-candidates/{id}/approve", {
      params: { path: { id } },
      body: { expected_review_digest } as ApiBody<"/v1/patch-candidates/{id}/approve", "post">,
    });
    const result = data as Record<string, unknown>;
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
  async rejectPatchCandidate(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/patch-candidates/{id}/reject", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/patch-candidates/{id}/reject", "post">,
    });
    return data as Record<string, unknown>;
  },

  triggerSelfHealingScan(
    this: EngineClient,
    body: { workflow_id?: string; connector_id?: string } = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const extraHeaders = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request("POST", "/v1/self-healing/scans", body, undefined, undefined, extraHeaders);
  },
  async listSelfHealingScans(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/self-healing/scans", {
      params: { query: query as ApiQuery<"/v1/self-healing/scans", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async getSelfHealingScan(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/self-healing/scans/{id}", {
      params: { path: { id } },
    });
    return data as Record<string, unknown>;
  },
};
