import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { BadRequestError } from "../http/errors.ts";

export const MCP_TRUST_KEY = "tools_without_confirmation";

function mcpBlock(config: unknown): Record<string, unknown> | null {
  if (!config || typeof config !== "object") return null;
  const mcp = (config as Record<string, unknown>).mcp;
  return mcp && typeof mcp === "object" && !Array.isArray(mcp)
    ? (mcp as Record<string, unknown>)
    : null;
}

export function mcpTrustedTools(config: unknown): string[] {
  const list = mcpBlock(config)?.[MCP_TRUST_KEY];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((v): v is string => typeof v === "string"))].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function carryMcpTrustList(
  driver: string,
  prior: unknown,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (driver !== "mcp" || next === undefined) return next;
  const stored = mcpTrustedTools(prior);
  const incomingBlock = mcpBlock(next);
  const incoming = incomingBlock?.[MCP_TRUST_KEY];
  if (incoming !== undefined) {
    if (!sameList(mcpTrustedTools(next), stored)) {
      throw new BadRequestError(
        "config.mcp.tools_without_confirmation is set per tool by an operator " +
          "(PUT /v1/connectors/{id}/mcp/tool-confirmation), not through a connector edit",
        { field: `config.mcp.${MCP_TRUST_KEY}` },
      );
    }
    return next;
  }
  if (stored.length === 0) return next;
  return { ...next, mcp: { ...(incomingBlock ?? {}), [MCP_TRUST_KEY]: stored } };
}

export function withoutMcpTrustList(config: unknown): Record<string, unknown> {
  const base =
    config && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  const mcp = mcpBlock(base);
  if (!mcp || !(MCP_TRUST_KEY in mcp)) return base;
  const { [MCP_TRUST_KEY]: _dropped, ...rest } = mcp;
  return { ...base, mcp: rest };
}

export async function readMcpToolsWithoutConfirmation(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<string[]> {
  const rows = await db
    .select({ config: connectors.config, driver: connectors.driver })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, connector_id),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row?.driver !== "mcp") return [];
  return mcpTrustedTools(row.config);
}

export interface SetMcpToolConfirmationParams {
  tenant_id: string;
  connector_id: string;
  tool: string;
  confirm: boolean;
  actor_id: string | null;
}

export interface McpToolConfirmationResult {
  tool: string;
  confirm: boolean;
  tools_without_confirmation: string[];
}

export async function setMcpToolConfirmation(
  db: Executor,
  p: SetMcpToolConfirmationParams,
): Promise<McpToolConfirmationResult | null> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, p.tenant_id),
          eq(connectors.id, p.connector_id),
          isNull(connectors.deleted_at),
        ),
      )
      .for("update");
    const prior = rows[0];
    if (prior?.driver !== "mcp") return null;
    const before = mcpTrustedTools(prior.config);
    const after = p.confirm
      ? before.filter((name) => name !== p.tool)
      : [...new Set([...before, p.tool])].sort();
    const config = (prior.config ?? {}) as Record<string, unknown>;
    const mcp = mcpBlock(config) ?? {};
    const { [MCP_TRUST_KEY]: _old, ...rest } = mcp;
    const nextConfig = {
      ...config,
      mcp: after.length > 0 ? { ...rest, [MCP_TRUST_KEY]: after } : rest,
    };
    await tx
      .update(connectors)
      .set({ config: nextConfig, updated_at: new Date() })
      .where(and(eq(connectors.tenant_id, p.tenant_id), eq(connectors.id, p.connector_id)));
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONNECTOR_UPDATED,
        resource_type: "connector",
        resource_id: p.connector_id,
        result: "success",
        reason: "mcp_tool_confirmation",
        before: { [MCP_TRUST_KEY]: before },
        after: { [MCP_TRUST_KEY]: after },
        metadata: {
          driver: "mcp",
          tool: p.tool,
          old_confirm: !before.includes(p.tool),
          new_confirm: p.confirm,
        },
      },
      tx,
    );
    return { tool: p.tool, confirm: p.confirm, tools_without_confirmation: after };
  });
}
