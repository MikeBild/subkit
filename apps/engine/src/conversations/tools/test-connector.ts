// `test_connector` — driver health probe against a saved connector.
//
// Distinct from `probe_connector`:
//   - `probe_connector` issues a custom authoring-time HTTP request
//     (the LLM picks method + path + headers) so the model can sniff
//     the response shape before writing a `request` step.
//   - `test_connector` runs the driver's canned health check (HTTP
//     GET base_url, Postgres SELECT 1, S3 list-bucket, etc). Use it to
//     answer the operator's question "is this connector healthy?"
//     after a credential rotation, after self-healing approved a
//     patch, or before re-running a workflow that previously failed.
//
// Distinct from `probe_connector_draft`:
//   - `probe_connector_draft` runs against a pre-creation envelope
//     held in the conversation's draft state — the connector row does
//     not exist yet.
//   - `test_connector` runs against a persisted `connectors` row.
//
// Mirrors the HTTP route POST /v1/connectors/:id/test exactly so any
// surface (CLI, MCP, converse) gets the same audit row + decision.

import { z } from "@hono/zod-openapi";
import { and, eq, isNull, ne } from "drizzle-orm";
import { recordConnectorInvoked } from "../../audit/recorders/connector.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import { getConnector } from "../../connectors/service.ts";
import { credentials } from "../../db/schema/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/**
 * G6 (runtime-logs review plan): compute the partial-grant diff between
 * the scopes the connector template expects and the scopes the IdP
 * actually returned on the most recent OAuth flow.
 *
 * Returns null when:
 *   - the connector is not oauth2 (no scope contract),
 *   - the credential row carries no `granted_scopes` (pre-G6 row or the
 *     IdP did not echo scope back on the token-exchange response),
 *   - the connector template declares no expected scope set.
 *
 * Otherwise returns `{ expected, granted, missing, partial_grant }`.
 * `partial_grant` is true iff `missing.length > 0` — used by
 * `test_connector` to flag the credential as silently degraded.
 */
function diffOauthScopes(
  expectedScopeStr: string | null | undefined,
  grantedScopeStr: string | null | undefined,
): {
  expected: string[];
  granted: string[];
  missing: string[];
  partial_grant: boolean;
} | null {
  if (!expectedScopeStr || !grantedScopeStr) return null;
  const splitScopes = (s: string): string[] =>
    s
      .split(/\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  const expected = splitScopes(expectedScopeStr);
  const granted = splitScopes(grantedScopeStr);
  if (expected.length === 0) return null;
  const grantedSet = new Set(granted);
  const missing = expected.filter((s) => !grantedSet.has(s));
  return {
    expected,
    granted,
    missing,
    partial_grant: missing.length > 0,
  };
}

const TestConnectorInput = z
  .object({
    connector_id: z.string().uuid().describe("UUID of the saved connector to probe."),
  })
  .openapi("TestConnectorToolInput");

export const testConnectorTool: ConversationTool = {
  name: "test_connector",
  description:
    "Probe a saved connector's health using its registered driver. Returns {ok, latency_ms, status?, detail?}. Use after credential rotation, after a self-healing patch is approved, or before re-running a workflow that previously failed. Do NOT suggest a curl/CLI command instead.",
  use_case:
    "Verifying that a saved connector still works in this environment. For pre-creation drafts use `probe_connector_draft`; for sniffing an arbitrary endpoint shape use `probe_connector`.",
  important_notes: [
    "Runs the driver's canned health probe (HTTP HEAD/GET base_url, Postgres SELECT 1, S3 list, etc.) — the LLM does NOT pick the URL or method.",
    "Audit row (connector.invoked) records driver, environment, status, latency, outcome.",
    "Permission gate: connector:test on the resource. Same gate as POST /v1/connectors/:id/test.",
  ],
  inputSchema: TestConnectorInput,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = TestConnectorInput.parse(rawArgs);
    const connector = await getConnector(ctx.tenant_id, args.connector_id, ctx.db);
    if (!connector) {
      return {
        ok: false,
        error_code: "connector_not_found",
        message: `no connector with id ${args.connector_id}`,
      };
    }

    const result = await probeConnector({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      connector,
    });

    let url_host = "";
    if (connector.base_url) {
      try {
        url_host = new URL(connector.base_url).host;
      } catch {
        url_host = connector.base_url;
      }
    }
    await recordConnectorInvoked({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
      connector_id: connector.id,
      connector_slug: connector.slug,
      driver: connector.driver,
      environment: connector.environment,
      method: "PROBE",
      path: "/",
      url_host,
      status_code: result.status ?? (result.ok ? 200 : 0),
      latency_ms: result.latency_ms,
      outcome: result.ok ? "success" : "error",
      conversation_id: ctx.conversation_id,
    });

    // G6: OAuth scope diff. Read the credential's granted_scopes
    // (persisted by the callback handler at credential-write time)
    // and compare to connector.config.oauth.scope (the scope the
    // template requested). When the IdP returned a strict subset,
    // the credential silently 401s against APIs covered by the
    // missing scopes — the LLM needs that signal up-front rather
    // than chasing it through later request failures. Best-effort:
    // a DB blip or missing fields just hides the diff, never blocks.
    let scopeDiff: ReturnType<typeof diffOauthScopes> = null;
    if (connector.auth_type === "oauth2") {
      try {
        const credRows = await ctx.db
          .select({ granted_scopes: credentials.granted_scopes })
          .from(credentials)
          .where(
            and(
              eq(credentials.tenant_id, ctx.tenant_id),
              eq(credentials.connector_id, connector.id),
              eq(credentials.environment, connector.environment),
              ne(credentials.mode, "oauth2_client"),
              isNull(credentials.deleted_at),
            ),
          )
          .limit(1);
        const granted = credRows[0]?.granted_scopes ?? null;
        const expected =
          connector.config &&
          typeof connector.config === "object" &&
          "oauth" in connector.config &&
          connector.config.oauth &&
          typeof connector.config.oauth === "object" &&
          "scope" in (connector.config.oauth as Record<string, unknown>)
            ? ((connector.config.oauth as { scope?: unknown }).scope as string | null | undefined)
            : null;
        scopeDiff = diffOauthScopes(expected ?? null, granted);
      } catch {
        // Diagnostic-only; never block the probe envelope on a DB read.
        scopeDiff = null;
      }
    }

    return {
      ok: true,
      data: {
        connector_id: connector.id,
        slug: connector.slug,
        driver: connector.driver,
        environment: connector.environment,
        ok: result.ok,
        latency_ms: result.latency_ms,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        // G10: typed probe-error classification + provider deep link.
        // Surfaces from the driver layer when a 4xx/5xx response can
        // be reduced to a discrete error_code (credential_invalid,
        // scope_insufficient, remote_resource_not_found,
        // remote_api_disabled, credential_missing, ...). The LLM
        // branches on this code instead of regex-matching `detail`.
        ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
        ...(result.provider_action_url !== undefined
          ? { provider_action_url: result.provider_action_url }
          : {}),
        // G6: partial-grant surface. Present only when both expected
        // and granted scope sets are known AND non-empty; absent
        // otherwise so the LLM does not see noisy "no diff available"
        // signals on every probe envelope.
        ...(scopeDiff !== null
          ? {
              partial_grant: scopeDiff.partial_grant,
              granted_scopes: scopeDiff.granted,
              expected_scopes: scopeDiff.expected,
              ...(scopeDiff.partial_grant
                ? {
                    missing_scopes: scopeDiff.missing,
                    partial_grant_note: `the IdP granted ${scopeDiff.granted.length}/${scopeDiff.expected.length} requested scopes; calls against APIs covered by [${scopeDiff.missing.join(", ")}] will 401. Re-run authenticate_oauth and tick every box on the consent screen, OR enable any APIs in the provider console whose scope was rejected by default.`,
                  }
                : {}),
            }
          : {}),
      },
    };
  },
};
