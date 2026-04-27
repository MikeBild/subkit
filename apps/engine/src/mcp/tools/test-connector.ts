// MCP `test_connector` product tool.
//
// Wraps the same probe driver registry used by
// `POST /v1/connectors/:id/test`. Available in every MCP mode (product /
// authoring / admin) so an external chat can verify a saved connector
// mid-conversation — for example after a credential rotation or after
// the operator approved a self-healing patch — without dropping out of
// the loop into a CLI command.
//
// Companion to `probe_connector_draft`: that one runs against a
// pre-creation draft envelope; this one runs against a persisted
// connector by id. The result envelope shape matches the HTTP route
// 1:1 so any client can consume both surfaces uniformly.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { recordConnectorInvoked } from "../../audit/recorders/connector.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import { getConnector } from "../../connectors/service.ts";
import type { Db } from "../../db/client.ts";
import { can } from "../../rbac/evaluator.ts";

export const TEST_CONNECTOR_TOOL_NAME = "test_connector";

export const testConnectorMcpTool: Tool = {
  name: TEST_CONNECTOR_TOOL_NAME,
  description:
    "Probe a saved connector's health using its registered driver. Returns {ok, latency_ms, status?, detail?}. Use after credential rotation or before re-running a workflow that previously failed; do NOT suggest a curl/CLI command instead. For pre-creation drafts use `probe_connector_draft`.",
  inputSchema: {
    type: "object",
    properties: {
      connector_id: {
        type: "string",
        description: "UUID of the saved connector to probe.",
      },
    },
    required: ["connector_id"],
    additionalProperties: false,
  },
};

export interface TestConnectorArgs {
  connector_id: string;
}

export interface TestConnectorResult {
  connector_id: string;
  slug: string;
  driver: string;
  environment: string;
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
}

export async function handleTestConnector(
  ctx: { db: Db; principal: ResolvedPrincipal },
  args: TestConnectorArgs,
): Promise<{ ok: true; data: TestConnectorResult } | { ok: false; data: { error: string } }> {
  const connector_id = args.connector_id ?? "";
  if (!connector_id) {
    return { ok: false, data: { error: "connector_id is required" } };
  }

  // Mirror the HTTP route's RBAC: connector:test is the gate the
  // `/v1/connectors/:id/test` route uses. Reusing it keeps the audit
  // trail and policy decisions consistent across both surfaces.
  const decision = await can(ctx.db, {
    tenant_id: ctx.principal.tenant_id,
    principal: ctx.principal,
    permission: "connector:test",
    resource: { type: "connector", id: connector_id },
  });
  if (!decision.allow) {
    return {
      ok: false,
      data: { error: decision.reason ?? "permission_denied" },
    };
  }

  const connector = await getConnector(ctx.principal.tenant_id, connector_id, ctx.db);
  if (!connector) {
    return { ok: false, data: { error: "connector_not_found" } };
  }

  const result = await probeConnector({
    db: ctx.db,
    tenant_id: ctx.principal.tenant_id,
    connector,
  });

  // Audit the probe through the same recorder that `/v1/connectors/:id/test`
  // and the converse `probe_connector` tool use. The recorder normalizes
  // the metadata shape so a single audit query can see probes from any
  // surface.
  let url_host = "";
  if (connector.base_url) {
    try {
      url_host = new URL(connector.base_url).host;
    } catch {
      url_host = connector.base_url;
    }
  }
  await recordConnectorInvoked({
    tenant_id: ctx.principal.tenant_id,
    actor_id: ctx.principal.id,
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
    executor: ctx.db,
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
}
