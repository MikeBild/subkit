import type { CatalogMetadataPatch } from "../../api/catalog-metadata.ts";
import type { AuthType, DriverName, Environment } from "../types.ts";
import {
  validateConnectorAuthType,
  validateMcpAuthConsistency,
  validateSignedJwtAuthConfig,
} from "./config-policy.ts";

export interface ConnectorConfigIssue {
  readonly path: string;
  readonly message: string;
}

export function authTypeIssue(
  driver: DriverName,
  authType: AuthType | undefined,
): ConnectorConfigIssue | null {
  return validateConnectorAuthType(driver, authType)[0] ?? null;
}

export function mcpAuthConsistencyIssue(
  driver: DriverName,
  authType: AuthType,
  config: Record<string, unknown> | undefined,
): ConnectorConfigIssue | null {
  return validateMcpAuthConsistency(driver, authType, config)[0] ?? null;
}

export function signedJwtAuthConfigIssue(
  authType: AuthType,
  config: Record<string, unknown> | undefined,
): ConnectorConfigIssue | null {
  return validateSignedJwtAuthConfig(authType, config)[0] ?? null;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function metadataPatchOf(input: {
  readonly accept_description?: boolean | undefined;
  readonly description?: string | null | undefined;
  readonly category?: string | null | undefined;
}): CatalogMetadataPatch {
  return {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.accept_description !== undefined
      ? { accept_description: input.accept_description }
      : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
  };
}

export function isCircuitOpenBlocking(
  connector: Readonly<{
    circuit_state: "closed" | "open" | "half-open";
    circuit_opened_at: Date | null;
    circuit_reset_ms: number;
  }>,
  nowMs: number,
): boolean {
  if (connector.circuit_state !== "open") return false;
  if (connector.circuit_opened_at === null) return false;
  return nowMs - connector.circuit_opened_at.getTime() < connector.circuit_reset_ms;
}

export function connectorEnvironmentKey(connectorId: string, environment: Environment): string {
  return `${connectorId}:${environment}`;
}

export function oauthScopeOf(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const oauth = (config as Record<string, unknown>).oauth;
  if (!oauth || typeof oauth !== "object") return null;
  const scope = (oauth as Record<string, unknown>).scope;
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

export function templateWasRebound(
  currentTemplateSlug: string | null | undefined,
  requestedTemplateSlug: string | null | undefined,
  clearTemplateBinding: boolean | undefined,
): boolean {
  return (
    clearTemplateBinding === true ||
    (requestedTemplateSlug != null && requestedTemplateSlug !== currentTemplateSlug)
  );
}

const MCP_TRUST_KEY = "tools_without_confirmation";

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
  return [...new Set(list.filter((value): value is string => typeof value === "string"))].sort();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type McpTrustCarryDecision =
  | Readonly<{ kind: "accepted"; config: Record<string, unknown> | undefined }>
  | Readonly<{ kind: "rejected" }>;

export function decideMcpTrustCarryOver(
  driver: string,
  prior: unknown,
  next: Record<string, unknown> | undefined,
): McpTrustCarryDecision {
  if (driver !== "mcp" || next === undefined) return { kind: "accepted", config: next };
  const stored = mcpTrustedTools(prior);
  const incomingBlock = mcpBlock(next);
  const incoming = incomingBlock?.[MCP_TRUST_KEY];
  if (incoming !== undefined) {
    return sameList(mcpTrustedTools(next), stored)
      ? { kind: "accepted", config: next }
      : { kind: "rejected" };
  }
  if (stored.length === 0) return { kind: "accepted", config: next };
  return {
    kind: "accepted",
    config: { ...next, mcp: { ...(incomingBlock ?? {}), [MCP_TRUST_KEY]: stored } },
  };
}
