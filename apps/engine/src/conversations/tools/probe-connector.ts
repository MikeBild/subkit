import { z } from "@hono/zod-openapi";
import { actorOf, auditActor } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction } from "../../audit/types.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { findConnectorRowBySlug } from "../../connectors/tool-lookups.ts";
import type { ConnectorView } from "../../connectors/types.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import type { ResolvedAuthorityReference } from "../../llm/substitution/resolver.ts";
import { resolvePlaceholders } from "../../llm/substitution/resolver.ts";
import { logger } from "../../logging/index.ts";
import { recordSuccessShape } from "../../schema-versions/index.ts";
import { DirectConnectorBindingError } from "../../tools/direct-connector-binding.ts";
import { truncateForLlm } from "../../tools/truncate.ts";
import { endpointKeyPath } from "./call-connector.ts";
import { directConnectorGuard, preflightDirectConnector } from "./direct-connector-guard.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { pickProbeRecoveryActions } from "./probe-recovery.ts";
import { summarizeProbeBody } from "./probe-shape.ts";

const Method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const Environment = z.enum(["dev", "prod"]);

const ProbeInput = z
  .object({
    connector_slug: z.string().min(1, "connector_slug is required"),
    method: Method.default("GET"),
    path: z
      .string()
      .min(1)
      .default("/")
      .describe("Path relative to the connector's base_url, or a full URL."),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
    environment: Environment.default("dev"),
    timeout_ms: z.number().int().min(100).max(60_000).default(15_000),
    response_mode: z.enum(["shape", "sample", "full"]).default("shape"),
  })
  .openapi("ProbeConnectorToolInput");

interface RateBucket {
  count: number;
  window_start_ms: number;
}
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const RATE_BUCKET_EXPIRY_MS = RATE_WINDOW_MS * 2;
const BUCKET_HARD_CAP = 10_000;
const SWEEP_EVERY_N_READS = 256;
const rateBuckets = new Map<string, RateBucket>();
let readsSinceSweep = 0;

function sweepExpiredBuckets(now: number): void {
  for (const [id, bucket] of rateBuckets) {
    if (now - bucket.window_start_ms >= RATE_BUCKET_EXPIRY_MS) {
      rateBuckets.delete(id);
    }
  }
}

function consumeRateToken(conversation_id: string): boolean {
  const now = Date.now();
  if (++readsSinceSweep >= SWEEP_EVERY_N_READS) {
    readsSinceSweep = 0;
    sweepExpiredBuckets(now);
  }
  if (rateBuckets.size >= BUCKET_HARD_CAP) {
    const oldest = rateBuckets.keys().next().value;
    if (oldest !== undefined) rateBuckets.delete(oldest);
  }
  const bucket = rateBuckets.get(conversation_id);
  if (!bucket || now - bucket.window_start_ms >= RATE_WINDOW_MS) {
    rateBuckets.set(conversation_id, { count: 1, window_start_ms: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

export function resetProbeRateLimit(conversation_id?: string): void {
  if (conversation_id) rateBuckets.delete(conversation_id);
  else rateBuckets.clear();
}

export function _probeRateBucketCountForTests(): number {
  return rateBuckets.size;
}

export function _consumeRateTokenForTests(conversation_id: string): boolean {
  return consumeRateToken(conversation_id);
}

export const _RATE_BUCKET_HARD_CAP_FOR_TESTS = BUCKET_HARD_CAP;

async function lookupConnectorBySlug(
  db: Db,
  tenant_id: string,
  slug: string,
  environment: "dev" | "prod" | null,
): Promise<ConnectorView | null> {
  const row = await findConnectorRowBySlug(db, tenant_id, slug, environment);
  if (!row) return null;
  return row as unknown as ConnectorView;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase();
}

function denyResult(code: string, message: string): ToolResult {
  return {
    ok: false,
    data: {
      error: { code, message },
      persistence: "none" as const,
    },
  };
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  if (error instanceof Error) {
    return /timed? out|timeout|aborted/i.test(error.message);
  }
  return /timed? out|timeout|aborted/i.test(String(error));
}

export const probeConnectorTool: ConversationTool = {
  name: "probe_connector",
  description:
    "Perform a one-shot authenticated HTTP call against a configured connector. The default response_mode:shape returns field paths and types without values; sample returns a few bounded values; full requires confirmation. Use this to verify an API before authoring a step.",
  use_case:
    "Call BEFORE writing `request` step configs or `transform` expressions that depend on a vendor payload shape. A probe reveals field names, status codes, and error bodies — grounding the LLM so it does not hallucinate paths.",
  important_notes: [
    "Does NOT create an `executions` row — this is an authoring-time aid, not a workflow run.",
    "Rate-limited to 20 probes / minute / conversation; over the limit the tool returns `probe_rate_limited`.",
    "Audit row (action=conversation.probe_connector) captures the connector slug + URL host + status, never the full URL or body.",
    "Read-only shape and sample probes can run in prod without a separate confirmation. Writes and response_mode:full require confirmation; wait for the operator when prompted.",
    `Use \`\${cred.<slug>.<field>}\` in headers/query/body — the resolver substitutes credentials safely and records placeholder names (not values) on the audit row.`,
  ],
  requires_skill: "http-connectors",
  example_input: {
    connector_slug: "stripe",
    method: "GET",
    path: "/v1/customers",
    environment: "dev",
  },
  inputSchema: ProbeInput,
  category: "tenant_read",
  permission: {
    action: "connector:read",
    resourceType: "connector",
    resolveResourceId: async (ctx, rawArgs) => {
      const args = ProbeInput.parse(rawArgs);
      const connector = await lookupConnectorBySlug(
        ctx.db,
        ctx.tenant_id,
        args.connector_slug,
        rawArgs.environment === undefined ? null : args.environment,
      );
      return connector?.id ?? null;
    },
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = ProbeInput.parse(rawArgs);

    if (!consumeRateToken(ctx.conversation_id)) {
      return denyResult(
        "probe_rate_limited",
        `probe_connector is capped at ${RATE_LIMIT} requests per minute per conversation`,
      );
    }

    const explicitEnv =
      typeof rawArgs === "object" &&
      rawArgs !== null &&
      (rawArgs as Record<string, unknown>).environment !== undefined;

    const connector = await lookupConnectorBySlug(
      ctx.db,
      ctx.tenant_id,
      args.connector_slug,
      explicitEnv ? args.environment : null,
    );
    if (!connector) {
      return denyResult(
        "connector_not_found",
        explicitEnv
          ? `no connector with slug '${args.connector_slug}' in ${args.environment}`
          : `no connector with slug '${args.connector_slug}'`,
      );
    }

    const environment = explicitEnv ? args.environment : connector.environment;
    try {
      await preflightDirectConnector(ctx, connector);
    } catch (error) {
      if (error instanceof DirectConnectorBindingError)
        return denyResult(error.code, error.message);
      throw error;
    }

    let credentialDescriptor: { mode: string; present: boolean } | null = null;
    if (connector.auth_type !== "none") {
      const cred = await getCredentialForConnector(
        ctx.tenant_id,
        connector.id,
        environment,
        ctx.db,
      );
      const oauth2TokenEmpty = cred?.value.mode === "oauth2" && !cred.value.access_token;
      credentialDescriptor = {
        mode: cred?.value.mode ?? "none",
        present: cred !== null && !oauth2TokenEmpty,
      };
      if (!cred) {
        return denyResult(
          "credential_required",
          `connector '${args.connector_slug}' (${environment}) has no saved credential — collect one (ask_user_form) and persist via save_connector_draft({credential}) first`,
        );
      }
      if (oauth2TokenEmpty) {
        return denyResult(
          "authenticate_oauth_required",
          `connector '${args.connector_slug}' (${environment}) has an oauth2 credential with no access token — complete the OAuth2 authorization before probing`,
        );
      }
    }

    const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
    const references: ResolvedAuthorityReference[] = [];
    const resolved = await resolvePlaceholders(
      {
        path: args.path,
        headers: args.headers ?? {},
        query: args.query ?? {},
        body: args.body ?? null,
      },
      {
        tenant_id: ctx.tenant_id,
        environment,
        db: ctx.db,
        ...(principal ? { principal } : {}),
        onAuthorityReference: (reference: ResolvedAuthorityReference) => {
          references.push(reference);
        },
      },
    );
    if (resolved.unresolved.length > 0) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "placeholder_unresolved",
            message: "one or more placeholders could not be resolved",
            details: {
              unresolved: resolved.unresolved.map((u) => ({
                token: u.token,
                code: u.code,
                message: u.message,
              })),
            },
          },
        },
      };
    }

    const resolvedValue = resolved.value as {
      path: string;
      headers: Record<string, string>;
      query: Record<string, string | number | boolean>;
      body: unknown;
    };

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let errorDetail: string | null = null;
    let authorityChanged = false;
    let usedHost = "";

    try {
      const guard = directConnectorGuard(ctx, connector, references);
      const execution = await executeConnectorHttpRequest({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector,
        ...(guard ? { before_dispatch: guard } : {}),
        method: args.method,
        path_or_url: resolvedValue.path,
        ...(resolvedValue.headers ? { headers: resolvedValue.headers } : {}),
        ...(resolvedValue.query ? { query: resolvedValue.query } : {}),
        ...(resolvedValue.body !== undefined ? { body: resolvedValue.body } : {}),
        timeout_ms: args.timeout_ms,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
      usedHost = hostOf(new URL(execution.url));
      status = execution.status;
      responseBody = execution.body;
    } catch (err) {
      authorityChanged = err instanceof DirectConnectorBindingError;
      errorDetail = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "conversation.probe_connector",
        action: "probe.fetch_failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_slug: args.connector_slug,
        environment,
        method: args.method,
        error: errorDetail,
      });
    }

    const duration_ms = Date.now() - started;
    const truncated =
      args.response_mode === "full"
        ? truncateForLlm(responseBody)
        : {
            data: summarizeProbeBody(responseBody, args.response_mode),
            truncated: false,
            raw_ref: undefined,
          };

    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        ...(principal
          ? auditActor(actorOf(principal))
          : resolveActor({ tenant_id: ctx.tenant_id, actor_id: ctx.actor_id })),
        action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
        resource_type: "connector",
        resource_id: connector.id,
        result: errorDetail ? "error" : "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          connector_slug: args.connector_slug,
          environment,
          method: args.method,
          url_host: usedHost,
          status_code: status,
          duration_ms,
          placeholders_used: resolved.placeholders_used,
        },
      },
      ctx.db,
    );

    if (errorDetail) {
      const timeout = isTimeoutError(errorDetail);
      const failure_code = authorityChanged
        ? "connector_authority_changed"
        : timeout
          ? "probe_timeout"
          : "probe_fetch_failed";
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: failure_code,
            message: timeout ? `Probe timed out after ${args.timeout_ms}ms.` : errorDetail,
          },
          next_best_actions: pickProbeRecoveryActions({ failure_code }),
          metadata: {
            connector_slug: args.connector_slug,
            method: args.method,
            environment,
            duration_ms,
            placeholders_used: resolved.placeholders_used,
          },
        },
      };
    }

    const isHttpFailure = status >= 400;

    if (!isHttpFailure && status >= 200 && status < 300 && responseBody !== null) {
      try {
        await recordSuccessShape(
          {
            tenant_id: ctx.tenant_id,
            connector_id: connector.id,
            endpoint_key: `${args.method} ${endpointKeyPath(resolvedValue.path)}`,
            value: responseBody,
          },
          ctx.db,
        );
      } catch (err) {
        logger.warn({
          module: "conversation.probe_connector",
          action: "probe.shape_record_failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        status_code: status,
        duration_ms,
        body: truncated.data,
        truncated: truncated.truncated,
        raw_ref: truncated.raw_ref,
        placeholders_used: resolved.placeholders_used,
        ...(credentialDescriptor ? { credential: credentialDescriptor } : {}),
        ...(isHttpFailure ? { next_best_actions: pickProbeRecoveryActions({ status }) } : {}),
        metadata: {
          connector_slug: args.connector_slug,
          method: args.method,
          environment,
        },
      },
    };
  },
};
