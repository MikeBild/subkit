import { discoverMcpOAuthIssuer } from "../../connectors/index.ts";
import { logger } from "../../logging/index.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mcpAuth(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(config.mcp).auth);
}

export function preRegisteredClientNeedsIssuer(
  config: Record<string, unknown>,
  credential: { mode: string; client_id?: string } | undefined,
): boolean {
  const auth = mcpAuth(config);
  const hasClient =
    (typeof auth.client_id === "string" && auth.client_id.length > 0) ||
    (credential?.mode === "oauth2" && Boolean(credential.client_id));
  return hasClient && !(typeof auth.issuer === "string" && auth.issuer.length > 0);
}

export function withMcpIssuer(
  config: Record<string, unknown>,
  issuer: string,
): Record<string, unknown> {
  const mcp = asRecord(config.mcp);
  return { ...config, mcp: { ...mcp, auth: { ...mcpAuth(config), issuer } } };
}

export type McpIssuerBinding =
  | { ok: true; config: Record<string, unknown>; discovered: boolean }
  | { ok: false; result: ToolResult };

export async function bindMcpClientIssuer(
  ctx: ToolContext,
  p: {
    base_url: string | null | undefined;
    config: Record<string, unknown>;
    credential: { mode: string; client_id?: string } | undefined;
  },
): Promise<McpIssuerBinding> {
  if (!preRegisteredClientNeedsIssuer(p.config, p.credential))
    return { ok: true, config: p.config, discovered: false };
  const correlation_id = ctx.tool_call_id ?? ctx.conversation_id;
  const found = p.base_url
    ? await discoverMcpOAuthIssuer({
        tenant_id: ctx.tenant_id,
        exec: ctx.db,
        base_url: p.base_url,
        config: p.config,
      })
    : ({ ok: false, reason: "discovery_failed", detail: "no base_url" } as const);
  if (!found.ok) {
    logger.warn({
      module: "conversation_persistence",
      action: "save_connector.mcp_issuer_unresolved",
      msg: "pre-registered MCP OAuth client has no issuer and discovery could not resolve one",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      correlation_id,
      reason: found.reason,
      detail: found.detail,
    });
    const message =
      "The authorization server of this MCP server could not be discovered, so the pre-registered OAuth client cannot be bound to it. Set config.mcp.auth.issuer to the authorization server URL with update_connector_draft, then save again.";
    return {
      ok: false,
      result: {
        ok: false,
        error_code: "mcp_oauth_issuer_unresolved",
        message,
        next_best_actions: ["update_connector_draft", "save_connector_draft"],
        data: { error_code: "mcp_oauth_issuer_unresolved", message, reason: found.reason },
      },
    };
  }
  const config = withMcpIssuer(p.config, found.issuer);
  logger.info({
    module: "conversation_persistence",
    action: "save_connector.mcp_issuer_discovered",
    msg: "bound the pre-registered MCP OAuth client to the discovered authorization server",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    correlation_id,
    issuer_host: new URL(found.issuer).host,
  });
  return { ok: true, config, discovered: true };
}
