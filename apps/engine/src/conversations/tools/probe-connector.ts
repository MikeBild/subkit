// `probe_connector` — one-shot HTTP probe against a configured connector.
//
// Before authoring a `request` step (or a full workflow), the LLM should
// see the real shape of the API response so it can stop guessing field
// names. Probing takes less than one second and produces a truncated
// response envelope plus `placeholders_used` so the conversation context
// carries a proof that credentials were resolved — not inlined.
//
// The tool is deliberately NOT routed through the workflow executor: no
// `executions` row is created, no retry loop runs, and no pagination
// stitching happens. It's a bare HTTP call with credential substitution,
// audited, rate-limited, and truncated.
//
// Policy:
//   - RBAC: `connector:read` on the target connector (plus `workflow:run`
//     to ensure the principal can author workflows at all).
//   - Rate limit: 20 probes / minute / conversation. Over the limit the
//     tool returns `probe_rate_limited` without issuing a network call.
//   - `confirm_before_execution` is applied upstream when method is not
//     GET/HEAD or when `environment === "prod"` (see tool-policies.ts).

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import type { ConnectorView } from "../../connectors/types.ts";
import type { Db } from "../../db/client.ts";
import { connectors as connectorsTable } from "../../db/schema/index.ts";
import { resolvePlaceholders } from "../../llm/substitution/resolver.ts";
import { logger } from "../../logging/logger.ts";
import { recordSuccessShape } from "../../schema-versions/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { pickProbeRecoveryActions } from "./probe-recovery.ts";
import { truncateForLlm } from "./truncate.ts";

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
  })
  .openapi("ProbeConnectorToolInput");

// ---- rate limit ------------------------------------------------------------
//
// Per-conversation rate gate for the network probe. The bucket is a
// trivial fixed-window: one entry per conversation_id, refreshed when
// the window rolls over. Buckets are evicted opportunistically to keep
// the Map bounded:
//   - On every read, drop any bucket whose window is more than
//     RATE_BUCKET_EXPIRY_MS old (twice the active window — a small
//     grace so a probe right after the boundary still bumps the
//     existing entry instead of creating two).
//   - At BUCKET_HARD_CAP entries, drop the oldest-window entry to keep
//     a misbehaving caller from growing the Map to OOM (the prod 4 GB
//     transient spike investigation flagged this Map as one of the
//     unbounded module-level caches in the conversation hot path).

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
  // Amortised sweep — every Nth read, evict expired entries. Cheaper
  // than a setInterval timer and bounded by call rate, so an idle engine
  // doesn't spend CPU cycles maintaining an empty cache.
  if (++readsSinceSweep >= SWEEP_EVERY_N_READS) {
    readsSinceSweep = 0;
    sweepExpiredBuckets(now);
  }
  // Hard backstop — if the sweep budget hasn't kept up (e.g. a burst of
  // unique conversation_ids inside one window), drop the oldest entry.
  // Map iteration is insertion order, so the first key is the oldest.
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

/** Reset the bucket for a conversation — tests use this to keep runs independent. */
export function resetProbeRateLimit(conversation_id?: string): void {
  if (conversation_id) rateBuckets.delete(conversation_id);
  else rateBuckets.clear();
}

/** Test-only — inspect the live bucket count to assert eviction behaviour. */
export function _probeRateBucketCountForTests(): number {
  return rateBuckets.size;
}

/** Test-only — drive the gate directly without a DB / tool dispatcher. */
export function _consumeRateTokenForTests(conversation_id: string): boolean {
  return consumeRateToken(conversation_id);
}

/** Test-only — surface the cap so the unit test stays in lockstep with the source. */
export const _RATE_BUCKET_HARD_CAP_FOR_TESTS = BUCKET_HARD_CAP;

// ---- helpers ---------------------------------------------------------------

async function lookupConnectorBySlug(
  db: Db,
  tenant_id: string,
  slug: string,
  environment: "dev" | "prod",
): Promise<ConnectorView | null> {
  const rows = await db
    .select()
    .from(connectorsTable)
    .where(
      and(
        eq(connectorsTable.tenant_id, tenant_id),
        eq(connectorsTable.slug, slug),
        eq(connectorsTable.environment, environment),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // The ConnectorView shape matches the row columns exactly; cast here
  // after a defensive null-check on the minimally required fields.
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

// ---- the tool --------------------------------------------------------------

export const probeConnectorTool: ConversationTool = {
  name: "probe_connector",
  description:
    "Perform a one-shot authenticated HTTP call against a configured connector and return a truncated response envelope. Use this to verify the shape of an API before authoring a step.",
  use_case:
    "Call BEFORE writing `request` step configs or `transform` expressions that depend on a vendor payload shape. A probe reveals field names, status codes, and error bodies — grounding the LLM so it does not hallucinate paths.",
  important_notes: [
    "Does NOT create an `executions` row — this is an authoring-time aid, not a workflow run.",
    "Rate-limited to 20 probes / minute / conversation; over the limit the tool returns `probe_rate_limited`.",
    "Audit row (action=conversation.probe_connector) captures the connector slug + URL host + status, never the full URL or body.",
    "For non-GET methods or prod environment, the upstream policy inserts a confirm_before_execution elicitation; the LLM must wait for the operator.",
    `Use \`\${cred.<slug>.<field>}\` in headers/query/body — the resolver substitutes credentials safely and records placeholder names (not values) on the audit row.`,
  ],
  requires_skill: "http-connectors",
  example_input: {
    connector_slug: "stripe",
    method: "GET",
    path: "/v1/customers",
    query: { limit: 2 },
    environment: "dev",
  },
  inputSchema: ProbeInput,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = ProbeInput.parse(rawArgs);

    if (!consumeRateToken(ctx.conversation_id)) {
      return denyResult(
        "probe_rate_limited",
        `probe_connector is capped at ${RATE_LIMIT} requests per minute per conversation`,
      );
    }

    // Look up the connector. A missing connector (wrong slug / wrong env)
    // is the most common probe failure; the returned error includes the
    // placeholders the LLM should fix.
    const connector = await lookupConnectorBySlug(
      ctx.db,
      ctx.tenant_id,
      args.connector_slug,
      args.environment,
    );
    if (!connector) {
      return denyResult(
        "connector_not_found",
        `no connector with slug '${args.connector_slug}' in ${args.environment}`,
      );
    }

    // Resolve placeholders in every string field of headers/query/body.
    // Unresolved placeholders are fatal — we do not dispatch partial auth.
    const resolved = await resolvePlaceholders(
      {
        path: args.path,
        headers: args.headers ?? {},
        query: args.query ?? {},
        body: args.body ?? null,
      },
      {
        tenant_id: ctx.tenant_id,
        environment: args.environment,
        db: ctx.db,
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
    let usedHost = "";

    try {
      const execution = await executeConnectorHttpRequest({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector,
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
      errorDetail = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "conversation.probe_connector",
        action: "probe.fetch_failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_slug: args.connector_slug,
        environment: args.environment,
        method: args.method,
        error: errorDetail,
      });
    }

    const duration_ms = Date.now() - started;
    const truncated = truncateForLlm(responseBody);

    // Audit. Metadata deliberately excludes the URL path (may contain
    // IDs that hint at PII) and excludes the body entirely. We bind the
    // write to the caller's db executor so tests (and any caller-owned
    // transaction) get a consistent view of the audit trail.
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: ctx.actor_id ? "user" : "system",
        actor_id: ctx.actor_id,
        action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
        resource_type: "connector",
        resource_id: connector.id,
        result: errorDetail ? "error" : "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          connector_slug: args.connector_slug,
          environment: args.environment,
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
      const failure_code = timeout ? "probe_timeout" : "probe_fetch_failed";
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: failure_code,
            message: timeout ? `Probe timed out after ${args.timeout_ms}ms.` : errorDetail,
          },
          // Same recovery vocabulary as probe_connector_draft so the
          // LLM doesn't need to branch on which probe surface raised
          // the error. dry_run_step uses the same mapping.
          next_best_actions: pickProbeRecoveryActions({ failure_code }),
          metadata: {
            connector_slug: args.connector_slug,
            method: args.method,
            environment: args.environment,
            duration_ms,
            placeholders_used: resolved.placeholders_used,
          },
        },
      };
    }

    // HTTP-level failure (4xx / 5xx) — return ok: true at the tool
    // boundary because the request completed, but include a
    // `failure_signal` + recovery actions so the LLM can inspect the
    // status without re-parsing the response body. Successful 2xx
    // responses skip this surface.
    const isHttpFailure = status >= 400;

    // Successful probes record the observed top-level shape against
    // `schema_versions` so the drift detector and the next
    // `inspect_connector` / `suggest_jsonata_paths` call have a
    // canonical "what does this endpoint actually return" reference.
    // Pre-fix only request-step executions populated schema_versions
    // — probes were the LLM's primary discovery surface but their
    // observations were thrown away. Endpoint key is `<METHOD>
    // <path>` so multiple probes against the same endpoint reuse a
    // row.
    if (!isHttpFailure && status >= 200 && status < 300 && responseBody !== null) {
      try {
        await recordSuccessShape(
          {
            tenant_id: ctx.tenant_id,
            connector_id: connector.id,
            endpoint_key: `${args.method} ${resolvedValue.path}`,
            value: responseBody,
          },
          ctx.db,
        );
      } catch (err) {
        // Never let shape recording fail the probe — the LLM still
        // needs the response. Log and move on.
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
        ...(isHttpFailure ? { next_best_actions: pickProbeRecoveryActions({ status }) } : {}),
        metadata: {
          connector_slug: args.connector_slug,
          method: args.method,
          environment: args.environment,
        },
      },
    };
  },
};
