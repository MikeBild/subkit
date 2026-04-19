import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { probeGraphQLConnector } from "../../connectors/drivers/graphql.ts";
import { buildRequestPlan } from "../../connectors/drivers/http.ts";
import { probePgConnector } from "../../connectors/drivers/postgres.ts";
import { probeS3Connector } from "../../connectors/drivers/s3.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
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
  })
  .openapi("ProbeConnectorDraftToolInput");

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
      return { ok: false, data: { error: "start a connector draft first" } };
    }
    if (!validation.ok) {
      await ctx.setDraft(
        withConnectorDraft(currentDraft, { ...connector, validation }, "connector_probe_blocked"),
      );
      return { ok: false, data: { error: "connector draft is incomplete", validation } };
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
      await ctx.setDraft(
        withConnectorDraft(
          currentDraft,
          { ...connector, validation, latest_probe },
          res.ok ? "connector_probed" : "connector_probe_failed",
        ),
      );
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
        data: { latest_probe, detail: res.detail ?? null },
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
      await ctx.setDraft(
        withConnectorDraft(
          currentDraft,
          { ...connector, validation, latest_probe },
          res.ok ? "connector_probed" : "connector_probe_failed",
        ),
      );
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
        data: { latest_probe, detail: res.detail ?? null },
      };
    }

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let errorDetail: string | null = null;
    let requestUrl = "";

    try {
      const plan = await buildRequestPlan({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
        path_or_url: args.path,
        headers: args.headers ?? {},
        query: args.query ?? {},
      });
      requestUrl = plan.url.toString();
      const headers = { ...plan.headers };
      const init: RequestInit = { method: args.method, headers };
      if (args.body !== undefined && args.method !== "GET" && args.method !== "HEAD") {
        if (typeof args.body === "string") {
          init.body = args.body;
        } else {
          init.body = JSON.stringify(args.body);
          if (!("content-type" in headers) && !("Content-Type" in headers)) {
            headers["content-type"] = "application/json";
          }
        }
      }
      const res = await fetch(plan.url, init);
      status = res.status;
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (contentType.includes("application/json") && text.length > 0) {
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
      } else {
        responseBody = text;
      }
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
          summary: `Probe failed: ${errorDetail}`,
          failure_code: "probe_failed",
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
    await ctx.setDraft(
      withConnectorDraft(
        currentDraft,
        { ...connector, validation, latest_probe },
        errorDetail ? "connector_probe_failed" : "connector_probed",
      ),
    );
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
        data: {
          error: errorDetail,
          latest_probe,
        },
      };
    }
    return {
      ok: latest_probe.ok,
      data: {
        connector: {
          ...toCreateConnectorInput(connector),
          environment: draftView.environment,
        },
        latest_probe,
        response_preview: truncated.data,
        truncated: truncated.truncated,
        raw_ref: truncated.raw_ref,
      },
    };
  },
};
