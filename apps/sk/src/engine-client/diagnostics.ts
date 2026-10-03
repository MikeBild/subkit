// Diagnostics + observability surfaces of the engine client: health,
// version/drift posture, log tailing, engine error ring, setup
// validation, runtime snapshot, audit log, and the composite status
// snapshot. Method group merged into `EngineClient` by
// `../engine-client.ts`.

import {
  DIAGNOSTICS_DRIFT_PATH,
  DIAGNOSTICS_LOG_STREAM_PATH,
  DIAGNOSTICS_LOG_TAIL_PATH,
} from "@cli-core/diagnostics-paths.ts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

// Aliased from the generated OpenAPI surface so command surfaces have a
// single import site and the snake_case wire shape stays authoritative.
export type DiagnosticsRuntime = components["schemas"]["DiagnosticsRuntime"];

export interface EngineErrorEntry {
  trace_id: string | null;
  ts: string;
  tenant_id: string | null;
  method: string;
  path: string;
  status: number;
  code: string;
  message: string;
  stack: string | null;
  bucket: "unhandled" | "llm_provider" | "llm_no_object" | "llm_timeout" | "llm_quota" | "http";
}

export interface SetupValidationIssue {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
}

export interface SetupValidationValue {
  key: string;
  value: string | null;
  status_hint: string | null;
}

export interface SetupValidationSection {
  title: string;
  status: "ok" | "warn" | "blocked";
  issues: SetupValidationIssue[];
  recommendations: string[];
  values: SetupValidationValue[];
}

export interface SetupValidationResponse {
  overall_status: "ok" | "warn" | "blocked";
  summary_counts: {
    blockers: number;
    warnings: number;
    sections_blocked: number;
    sections_warn: number;
  };
  sections: {
    auth: SetupValidationSection;
    llm: SetupValidationSection;
    datastore: SetupValidationSection;
    storage: SetupValidationSection;
    crypto: SetupValidationSection;
    public_urls: SetupValidationSection;
  };
  issues: SetupValidationIssue[];
  recommendations: string[];
}

export interface StatusSummary {
  user: { id: string; email: string | null; kind: "user" | "system_account" };
  tenant: { id: string; slug: string | null };
  connectors_count: number;
  skills_count: number;
  tokens_today: number;
  tokens_month: number;
  monthly_budget_tokens: number | null;
  remaining_monthly_budget_tokens: number | null;
  /**
   * The month against its cap, as the engine reads it (75 % tightening, 90 %
   * critical). Absent from an engine that predates it; null when uncapped.
   */
  monthly_budget_state?: "ample" | "tightening" | "critical" | null;
  /** The caller's own figures (null for system_account principals). */
  tokens_today_user: number | null;
  tokens_month_user: number | null;
  user_monthly_budget_tokens: number | null;
  user_remaining_monthly_budget_tokens: number | null;
  version: string;
}

export const diagnosticsMethods = {
  // --------------------------- Health + Health-like ---------------------------
  health(this: EngineClient): Promise<{
    status: "ok";
    service: "subkit";
    version: string;
  }> {
    return this.request("GET", "/health");
  },

  ready(this: EngineClient): Promise<{
    status: "ready" | "not_ready";
    service: "subkit";
    version: string;
    checks: { lifecycle: "pass" | "fail"; database: "pass" | "fail" };
  }> {
    return this.request("GET", "/ready");
  },

  // --------------------------- Version diagnostics ---------------------------
  /**
   * Engine version + update + schema-drift posture. Backed by
   * `/v1/diagnostics/version`, which requires `audit:read`. The
   * public `/health` deliberately omits these fields so the engine
   * does not leak operational posture to unauthenticated callers.
   */
  diagnosticsVersion(this: EngineClient): Promise<{
    engine_version: string;
    latest_version?: string;
    update_available: boolean;
    schema_drift: boolean;
    embedded_migrations_count: number;
  }> {
    return this.request("GET", "/v1/diagnostics/version");
  },

  integrationsHealth(this: EngineClient): Promise<{
    connectors: Array<{
      id: string;
      slug: string;
      environment: string;
      effective_health: "ok" | "degraded" | "needs_update" | "needs_reauth";
      health_reason: string | null;
      health_error_code: string | null;
      sunset_at: string | null;
      successor_uri: string | null;
      needs_reauth: boolean;
      circuit_state: string;
    }>;
    workflows_attention: Array<{
      id: string;
      slug: string;
      health_state: string;
      health_reason: string | null;
    }>;
    summary: {
      connectors_total: number;
      connectors_attention: number;
      workflows_attention: number;
    };
  }> {
    return this.request("GET", "/v1/diagnostics/integrations");
  },

  // --------------------------- Drift diagnostics ---------------------------
  /**
   * Detailed schema-drift report. Backed by `/v1/diagnostics/drift`,
   * which requires `audit:read`. Surfaces the rows in
   * `drizzle.__drizzle_migrations` that are unknown to the engine
   * binary, accepted pre-squash history, and missing embedded identities.
   */
  driftReport(this: EngineClient): Promise<{
    engine_version: string;
    embedded_migration_count: number;
    db_migration_count: number;
    unknown_in_db: Array<{
      row_id: number;
      hash: string;
      created_at: number | null;
      tag: string | null;
    }>;
    historical_in_db: Array<{
      row_id: number;
      hash: string;
      created_at: number | null;
      tag: string | null;
    }>;
    missing_in_db: Array<{ idx: number; tag: string; hash: string }>;
  }> {
    return this.request("GET", DIAGNOSTICS_DRIFT_PATH);
  },

  // --------------------------- Engine log tail ---------------------------
  /**
   * Pull a window of the engine's in-memory log ring buffer. Returns
   * raw JSON-line entries (each already structured with module / action
   * / msg). Backed by `/v1/diagnostics/logs?since=<unix_ms>&limit=<n>`,
   * which requires `audit:read`.
   */
  logsTailWindow(
    this: EngineClient,
    opts: {
      since_ms?: number;
      limit?: number;
      module?: string;
      action?: string;
      level?: string;
    },
  ): Promise<{
    entries: Array<{
      ts: number;
      level: string;
      module?: string;
      action?: string;
      msg?: string;
      fields?: Record<string, unknown>;
    }>;
    next_since_ms: number;
    capacity: number;
    size: number;
  }> {
    const params = new URLSearchParams();
    if (typeof opts.since_ms === "number") params.set("since", String(opts.since_ms));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    if (opts.module) params.set("module", opts.module);
    if (opts.action) params.set("action", opts.action);
    if (opts.level) params.set("level", opts.level);
    const qs = params.toString();
    return this.request("GET", `${DIAGNOSTICS_LOG_TAIL_PATH}${qs ? `?${qs}` : ""}`);
  },

  /**
   * Returns the absolute URL the SSE stream lives at. The caller wires
   * up its own `EventSource`/fetch-stream because each consumer
   * (Ink REPL, headless CLI tail) has different lifetime semantics.
   * Bearer auth must be added by the caller.
   */
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

  // --------------------------- Status snapshot ---------------------------
  /**
   * Composite status snapshot used by the Ink status-line ticker and the
   * `/status` pane. One round-trip instead of fanning out to /connectors
   * + /skills + /usage. Tenant-scoped by the engine.
   */
  statusSummary(this: EngineClient): Promise<StatusSummary> {
    return this.request("GET", "/v1/status");
  },

  // --------------------------- Audit (admin only) ---------------------------
  tailAuditLog(
    this: EngineClient,
    query: { actor_id?: string; action?: string; limit?: number } = {},
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request("GET", "/v1/audit-log", undefined, query);
  },

  // --------------------- Diagnostics (engine error ring) --------------------
  tailEngineErrors(
    this: EngineClient,
    query: { limit?: number; since?: string; trace_id?: string } = {},
  ): Promise<{ items: EngineErrorEntry[]; total_buffered: number }> {
    return this.request("GET", "/v1/diagnostics/errors", undefined, query);
  },

  setupValidation(this: EngineClient): Promise<SetupValidationResponse> {
    return this.request("GET", "/v1/diagnostics/setup");
  },

  /**
   * Live process-runtime snapshot — uptime, memory (rss / heap /
   * external MB), DB-pool saturation, and event-loop lag. Backed by
   * `/v1/diagnostics/runtime`. Surfaced by `sk health` so an operator
   * can see engine pressure (the OOM / event-loop-stall symptoms) from
   * the CLI without shelling onto the host. Return shape is the
   * generated OpenAPI schema.
   */
  diagnosticsRuntime(this: EngineClient): Promise<DiagnosticsRuntime> {
    return this.request("GET", "/v1/diagnostics/runtime");
  },

  getDiagnosticsLlm(this: EngineClient): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/diagnostics/llm");
  },

  // -------------------- Audit Log (extended) --------------------
  queryAuditLog(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    return this.request("GET", "/v1/audit-log", undefined, query);
  },
  getAuditEvent(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/audit-log/${encodeURIComponent(id)}`);
  },
  exportAuditLog(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<Response> {
    return this.stream("/v1/audit-log/export.ndjson", query);
  },
};
