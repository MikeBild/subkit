import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type PatchCandidate = Schemas["PatchCandidate"];
export type PatchCandidateListQuery = ApiQuery<"/v1/patch-candidates", "get">;
export type SelfHealingScanListQuery = ApiQuery<"/v1/self-healing/scans", "get">;
export type SelfHealingScanRequest = ApiBody<"/v1/self-healing/scans", "post">;
export type SelfHealingScanResponse = Schemas["SelfHealingScanResponse"];
export type SelfHealingScanRecord = Schemas["SelfHealingScanRecord"];
type PatchApproval = { applied: boolean; workflow_version_id: string | null };
type AppliedPatch = { applied: true; workflow_version_id: string };

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
    query: ApiQuery<"/v1/operator/health-digest", "get"> = {},
  ): Promise<OperatorHealthDigest> {
    const { data } = await this.api.GET("/v1/operator/health-digest", { params: { query } });
    return data as OperatorHealthDigest;
  },

  async listPatchCandidates(
    this: EngineClient,
    query: PatchCandidateListQuery = {},
  ): Promise<Schemas["PatchCandidateListResponse"]> {
    const { data } = await this.api.GET("/v1/patch-candidates", { params: { query } });
    return data as Schemas["PatchCandidateListResponse"];
  },
  async getPatchCandidate(this: EngineClient, id: string): Promise<PatchCandidate> {
    const { data } = await this.api.GET("/v1/patch-candidates/{id}", { params: { path: { id } } });
    return data as PatchCandidate;
  },
  async previewPatchCandidate(
    this: EngineClient,
    id: string,
  ): Promise<Schemas["PatchCandidatePreview"]> {
    const { data } = await this.api.GET("/v1/patch-candidates/{id}/preview", {
      params: { path: { id } },
    });
    return data as Schemas["PatchCandidatePreview"];
  },
  async approvePatchCandidate(
    this: EngineClient,
    id: string,
    expected_review_digest: string,
  ): Promise<AppliedPatch> {
    const { data } = await this.api.POST("/v1/patch-candidates/{id}/approve", {
      params: { path: { id } },
      body: { expected_review_digest },
    });
    const result = data as PatchApproval;
    if (result.applied !== true || !result.workflow_version_id) {
      throw new EngineError(409, {
        code: "patch_not_applicable",
        message: "The repair was not applied. Reload the candidate preview before approving.",
      });
    }
    return { ...result, applied: true, workflow_version_id: result.workflow_version_id };
  },
  async rejectPatchCandidate(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/patch-candidates/{id}/reject", "post"> = {},
  ): Promise<{ rejected: boolean }> {
    const { data } = await this.api.POST("/v1/patch-candidates/{id}/reject", {
      params: { path: { id } },
      body,
    });
    return data as { rejected: boolean };
  },

  triggerSelfHealingScan(
    this: EngineClient,
    body: SelfHealingScanRequest = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<SelfHealingScanResponse> {
    const extraHeaders = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request<SelfHealingScanResponse>(
      "POST",
      "/v1/self-healing/scans",
      body,
      undefined,
      undefined,
      extraHeaders,
    );
  },
  async listSelfHealingScans(
    this: EngineClient,
    query: SelfHealingScanListQuery = {},
  ): Promise<Schemas["SelfHealingScanListResponse"]> {
    const { data } = await this.api.GET("/v1/self-healing/scans", { params: { query } });
    return data as Schemas["SelfHealingScanListResponse"];
  },
  async getSelfHealingScan(this: EngineClient, id: string): Promise<SelfHealingScanRecord> {
    const { data } = await this.api.GET("/v1/self-healing/scans/{id}", {
      params: { path: { id } },
    });
    return data as SelfHealingScanRecord;
  },
};
