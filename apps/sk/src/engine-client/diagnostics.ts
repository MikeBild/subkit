import {
  DIAGNOSTICS_LOG_STREAM_PATH,
  DIAGNOSTICS_LOG_TAIL_PATH,
} from "@cli-core/diagnostics-paths.ts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type DiagnosticsRuntime = Schemas["DiagnosticsRuntime"];

export type EngineErrorEntry = Schemas["ErrorRingEntry"];
export type SetupValidationIssue = Schemas["DiagnosticsSetupIssue"];
export type SetupValidationValue = Schemas["DiagnosticsSetupValue"];
export type SetupValidationSection = Schemas["DiagnosticsSetupSection"];
export type SetupValidationResponse = Schemas["DiagnosticsSetupResponse"];
export type AuditLogQuery = ApiQuery<"/v1/audit-log", "get">;
export type AuditEntry = Schemas["AuditEntry"];

export type StatusSummary = Schemas["StatusSummary"];

type CheckState = "pass" | "fail" | "unknown";

function checkState(value: unknown): CheckState {
  return value === "pass" || value === "fail" ? value : "unknown";
}

export const diagnosticsMethods = {
  async health(this: EngineClient): Promise<{
    status: "ok";
    service: "subkit";
    version: string;
  }> {
    const body = (await this.api.GET("/health")).data as { status?: string; version?: unknown };
    if (typeof body.version === "string") {
      return { status: "ok", service: "subkit", version: body.version };
    }
    const descriptor = await this.api
      .GET("/.well-known/service-descriptor.json")
      .then(({ data }) => data as { version?: unknown })
      .catch(() => null);
    return {
      status: "ok",
      service: "subkit",
      version: typeof descriptor?.version === "string" ? descriptor.version : "unknown",
    };
  },

  async ready(this: EngineClient): Promise<{
    status: "ready" | "not_ready";
    service: "subkit";
    checks: { lifecycle: CheckState; database: CheckState };
  }> {
    const body = (await this.api.GET("/ready")).data as {
      status?: string;
      checks?: { lifecycle?: unknown; database?: unknown };
    };
    return {
      status: body.status === "ready" || body.status === "ok" ? "ready" : "not_ready",
      service: "subkit",
      checks: {
        lifecycle: checkState(body.checks?.lifecycle),
        database: checkState(body.checks?.database),
      },
    };
  },

  async diagnosticsVersion(this: EngineClient): Promise<Schemas["DiagnosticsVersionResponse"]> {
    const { data } = await this.api.GET("/v1/diagnostics/version");
    return data as Schemas["DiagnosticsVersionResponse"];
  },

  async integrationsHealth(
    this: EngineClient,
  ): Promise<Schemas["DiagnosticsIntegrationsResponse"]> {
    const { data } = await this.api.GET("/v1/diagnostics/integrations");
    return data as Schemas["DiagnosticsIntegrationsResponse"];
  },

  async driftReport(this: EngineClient): Promise<Schemas["DriftReport"]> {
    const { data } = await this.api.GET("/v1/diagnostics/drift");
    return data as Schemas["DriftReport"];
  },

  logsTailWindow(
    this: EngineClient,
    opts: {
      since_ms?: number;
      limit?: number;
      module?: string;
      action?: string;
      level?: string;
    },
  ): Promise<Schemas["LogTailResponse"]> {
    const params = new URLSearchParams();
    if (typeof opts.since_ms === "number") params.set("since", String(opts.since_ms));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    if (opts.module) params.set("module", opts.module);
    if (opts.action) params.set("action", opts.action);
    if (opts.level) params.set("level", opts.level);
    const qs = params.toString();
    return this.request("GET", `${DIAGNOSTICS_LOG_TAIL_PATH}${qs ? `?${qs}` : ""}`);
  },

  logsTailStreamUrl(
    this: EngineClient,
    opts: {
      since_ms?: number;
      module?: string;
      action?: string;
      level?: string;
    },
  ): string {
    const params = new URLSearchParams();
    if (typeof opts.since_ms === "number") params.set("since", String(opts.since_ms));
    if (opts.module) params.set("module", opts.module);
    if (opts.action) params.set("action", opts.action);
    if (opts.level) params.set("level", opts.level);
    const qs = params.toString();
    return `${this.base}${DIAGNOSTICS_LOG_STREAM_PATH}${qs ? `?${qs}` : ""}`;
  },

  async statusSummary(this: EngineClient): Promise<Schemas["StatusSummary"]> {
    const { data } = await this.api.GET("/v1/status");
    return data as Schemas["StatusSummary"];
  },

  async tailAuditLog(
    this: EngineClient,
    query: Pick<AuditLogQuery, "actor_id" | "action" | "limit"> = {},
  ): Promise<Schemas["AuditLogListResponse"]> {
    const { data } = await this.api.GET("/v1/audit-log", { params: { query } });
    return data as Schemas["AuditLogListResponse"];
  },

  async tailEngineErrors(
    this: EngineClient,
    query: ApiQuery<"/v1/diagnostics/errors", "get"> = {},
  ): Promise<Schemas["DiagnosticsErrorListResponse"]> {
    const { data } = await this.api.GET("/v1/diagnostics/errors", { params: { query } });
    return data as Schemas["DiagnosticsErrorListResponse"];
  },

  async setupValidation(this: EngineClient): Promise<SetupValidationResponse> {
    const { data } = await this.api.GET("/v1/diagnostics/setup");
    return data as SetupValidationResponse;
  },

  async diagnosticsRuntime(this: EngineClient): Promise<DiagnosticsRuntime> {
    const { data } = await this.api.GET("/v1/diagnostics/runtime");
    return data as DiagnosticsRuntime;
  },

  async getDiagnosticsLlm(this: EngineClient): Promise<Schemas["DiagnosticsLlmStatus"]> {
    const { data } = await this.api.GET("/v1/diagnostics/llm");
    return data as Schemas["DiagnosticsLlmStatus"];
  },

  async queryAuditLog(
    this: EngineClient,
    query: AuditLogQuery = {},
  ): Promise<Schemas["AuditLogListResponse"]> {
    const { data } = await this.api.GET("/v1/audit-log", { params: { query } });
    return data as Schemas["AuditLogListResponse"];
  },
  async getAuditEvent(this: EngineClient, id: string): Promise<AuditEntry> {
    const { data } = await this.api.GET("/v1/audit-log/{id}", { params: { path: { id } } });
    return data as AuditEntry;
  },
  exportAuditLog(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<Response> {
    return this.stream("/v1/audit-log/export.ndjson", query);
  },
};
