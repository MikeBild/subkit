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

export type FailureOrigin = Schemas["OperatorFailureGroup"]["origin"];
export type DigestFailureGroup = Schemas["OperatorFailureGroup"];
export type DigestPatch = Schemas["OperatorDigestPatch"];
export type RiskSeverity = Schemas["OperatorRiskSignal"]["severity"];
export type RiskSignal = Schemas["OperatorRiskSignal"];
export type AttentionItem = Schemas["AttentionItem"];
export type DigestAttention = Schemas["AttentionV1"];
export type OperatorHealthDigest = Schemas["OperatorHealthDigest"];

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

  async triggerSelfHealingScan(
    this: EngineClient,
    body: SelfHealingScanRequest = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<SelfHealingScanResponse> {
    const { data } = await this.api.POST("/v1/self-healing/scans", {
      params: { header: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {} },
      body,
    });
    return data as SelfHealingScanResponse;
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
