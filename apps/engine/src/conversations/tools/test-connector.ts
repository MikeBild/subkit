import { z } from "@hono/zod-openapi";
import { recordConnectorProbed } from "../../audit/recorders/connector.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import { computeConnectorScopeDiff } from "../../connectors/oauth-scope-diff.ts";
import { getConnector } from "../../connectors/service.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

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

    const actor = auditActorFromToolContext(ctx);
    const result = await probeConnector({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      connector,
      ...actor,
    });

    await recordConnectorProbed({
      tenant_id: ctx.tenant_id,
      ...actor,
      executor: ctx.db,
      connector,
      result,
      conversation_id: ctx.conversation_id,
    });

    const scopeDiff = await computeConnectorScopeDiff(ctx.db, ctx.tenant_id, connector);

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
        ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
        ...(result.provider_action_url !== undefined
          ? { provider_action_url: result.provider_action_url }
          : {}),
        ...(result.body_snippet !== undefined ? { body_snippet: result.body_snippet } : {}),
        ...(result.response_headers !== undefined
          ? { response_headers: result.response_headers }
          : {}),
        ...(scopeDiff !== null
          ? {
              partial_grant: scopeDiff.partial_grant,
              granted_scopes: scopeDiff.granted,
              expected_scopes: scopeDiff.expected,
              ...(scopeDiff.missing.length > 0 ? { missing_scopes: scopeDiff.missing } : {}),
              ...(scopeDiff.note ? { partial_grant_note: scopeDiff.note } : {}),
            }
          : {}),
      },
    };
  },
};
