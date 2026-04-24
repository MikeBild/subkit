import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { probeGraphQLConnector } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { probePgConnector } from "../../connectors/drivers/postgres.ts";
import { probeS3Connector } from "../../connectors/drivers/s3.ts";
import { withConnectorProbe, withConnectorValidation } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

const inputSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    path: z.string().min(1).default("/"),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).default(15_000),
  })
  .openapi("ProbeConnectorDraftToolInput");

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  if (error instanceof Error) {
    return /timed? out|timeout|aborted/i.test(error.message);
  }
  return /timed? out|timeout|aborted/i.test(String(error));
}

export const probeConnectorDraftTool: ConversationTool = {
  name: "probe_connector_draft",
  description:
    "Probe the current connector draft before saving it. Use this as the normal verification step for HTTP and GraphQL connectors.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const connector = currentDraft.connector;
    const validation = validateConnectorDraft(connector ?? null);
    if (!connector) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "connector_missing",
          message: "start a connector draft before probing it",
          recommended_mode: "connector",
        }),
      };
    }
    if (!validation.ok) {
      const nextDraft = withConnectorValidation(
        currentDraft,
        { ...connector, validation },
        false,
        "Connector draft is incomplete and cannot be probed yet.",
        "connector_probe_blocked",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildGateError(nextDraft, {
          error_code: "validation_failed",
          message: "connector draft is incomplete",
          stale_checkpoints: ["connector_validated"],
          recommended_mode: "connector",
          extra: {
            validation,
          },
        }),
      };
    }
    const effectiveDriver = connector.driver ?? "http";
    const draftView = {
      id: `draft-${ctx.conversation_id}`,
      tenant_id: ctx.tenant_id,
      slug: connector.slug ?? "draft-connector",
      display_name: connector.name ?? "Draft connector",
      driver: effectiveDriver,
      environment: args.environment ?? connector.environment ?? "dev",
      auth_type: connector.auth_type ?? "none",
      base_url: connector.base_url ?? null,
      dsn: connector.dsn ?? null,
      config: connector.config ?? {},
      created_at: new Date(),
      updated_at: new Date(),
      circuit_state: "closed" as const,
      circuit_opened_at: null,
      circuit_failure_count: 0,
      circuit_threshold: 5,
      circuit_reset_ms: 300000,
    };

    // Non-HTTP drivers run their dedicated read-only probe (connect +
    // shape check). HTTP continues below — it needs the full plan
    // builder so users can probe arbitrary endpoints, not just the
    // driver's canned handshake.
    if (connector.driver === "postgres" || connector.driver === "s3") {
      const started = Date.now();
      const res =
        connector.driver === "postgres"
          ? await probePgConnector(draftView)
          : await probeS3Connector({ db: ctx.db, tenant_id: ctx.tenant_id, connector: draftView });
      const duration_ms = Date.now() - started;
      const latest_probe = {
        ok: res.ok,
        method: connector.driver === "postgres" ? "SELECT 1" : "HEAD /",
        path: "(driver handshake)",
        environment: draftView.environment,
        ...(typeof (res as { status?: number }).status === "number"
          ? { status_code: (res as { status?: number }).status as number }
          : {}),
        duration_ms,
        summary: res.ok
          ? `${connector.driver} probe succeeded in ${duration_ms}ms.`
          : `${connector.driver} probe failed: ${res.detail ?? "unknown error"}`,
        ...(res.ok ? {} : { failure_code: "probe_failed" }),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        res.ok,
        latest_probe.summary,
        res.ok ? "connector_probed" : "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: res.ok ? "success" : "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: connector.driver,
            duration_ms,
            draft_only: true,
          },
        },
        ctx.db,
      );
      return {
        ok: res.ok,
        data: buildLifecyclePayload(nextDraft, {
          connector: {
            ...toCreateConnectorInput(connector),
            environment: draftView.environment,
          },
          latest_probe,
          detail: res.detail ?? null,
        }),
      };
    }

    if (connector.driver === "graphql" && args.path === "/") {
      // No explicit path supplied — run the minimal `{ __typename }` probe.
      // When the user supplies an explicit path the HTTP path below takes
      // over so they can exercise real endpoints.
      const started = Date.now();
      const res = await probeGraphQLConnector({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
      });
      const duration_ms = Date.now() - started;
      const latest_probe = {
        ok: res.ok,
        method: "POST",
        path: "(introspection)",
        environment: draftView.environment,
        ...(typeof res.status === "number" ? { status_code: res.status } : {}),
        duration_ms,
        summary: res.ok
          ? `GraphQL introspection probe succeeded in ${duration_ms}ms.`
          : `GraphQL probe failed: ${res.detail ?? `HTTP ${res.status ?? 0}`}`,
        ...(res.ok ? {} : { failure_code: "probe_failed" }),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        res.ok,
        latest_probe.summary,
        res.ok ? "connector_probed" : "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: res.ok ? "success" : "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: "graphql",
            duration_ms,
            draft_only: true,
          },
        },
        ctx.db,
      );
      return {
        ok: res.ok,
        data: buildLifecyclePayload(nextDraft, {
          connector: {
            ...toCreateConnectorInput(connector),
            environment: draftView.environment,
          },
          latest_probe,
          detail: res.detail ?? null,
        }),
      };
    }

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let errorDetail: string | null = null;
    let requestUrl = "";

    try {
      const execution = await executeConnectorHttpRequest({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
        method: args.method,
        path_or_url: args.path,
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        timeout_ms: args.timeout_ms,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
      requestUrl = execution.url;
      status = execution.status;
      responseBody = execution.body;
    } catch (error) {
      errorDetail = error instanceof Error ? error.message : String(error);
    }

    const duration_ms = Date.now() - started;
    const truncated = truncateForLlm(responseBody);
    const latest_probe = errorDetail
      ? {
          ok: false,
          method: args.method,
          path: args.path,
          environment: draftView.environment,
          duration_ms,
          summary: isTimeoutError(errorDetail)
            ? `Probe timed out after ${args.timeout_ms}ms.`
            : `Probe failed: ${errorDetail}`,
          failure_code: isTimeoutError(errorDetail) ? "probe_timeout" : "probe_failed",
        }
      : {
          ok: status >= 200 && status < 400,
          method: args.method,
          path: args.path,
          environment: draftView.environment,
          status_code: status,
          duration_ms,
          summary:
            status >= 200 && status < 400
              ? `Probe succeeded with HTTP ${status}.`
              : `Probe reached the system but returned HTTP ${status}.`,
          response_preview: truncated.data,
        };
    const nextDraft = withConnectorProbe(
      currentDraft,
      { ...connector, validation, latest_probe },
      latest_probe.ok,
      latest_probe.summary,
      errorDetail ? "connector_probe_failed" : "connector_probed",
    );
    await ctx.setDraft(nextDraft);
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: ctx.actor_id ? "user" : "system",
        actor_id: ctx.actor_id,
        action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
        resource_type: "conversation",
        resource_id: ctx.conversation_id,
        result: errorDetail ? "error" : "success",
        metadata: {
          connector_name: connector.name ?? null,
          connector_slug: connector.slug ?? null,
          environment: draftView.environment,
          method: args.method,
          path: args.path,
          url_host: requestUrl ? new URL(requestUrl).host : null,
          status_code: status,
          duration_ms,
          draft_only: true,
        },
      },
      ctx.db,
    );
    if (errorDetail) {
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          error: errorDetail,
          error_code: latest_probe.failure_code ?? "probe_failed",
          latest_probe,
        }),
      };
    }
    return {
      ok: latest_probe.ok,
      data: buildLifecyclePayload(nextDraft, {
        connector: {
          ...toCreateConnectorInput(connector),
          environment: draftView.environment,
        },
        latest_probe,
        response_preview: truncated.data,
        truncated: truncated.truncated,
        raw_ref: truncated.raw_ref,
      }),
    };
  },
};
