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
import { recordConnectorInvoked } from "../../audit/recorders/connector.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import { getConnector } from "../../connectors/service.ts";
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
      },
    };
  },
};
