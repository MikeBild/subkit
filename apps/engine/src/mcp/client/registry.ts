import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { scrubString } from "@shared/index.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordConnectorMcpClientRegistered } from "../../audit/recorders/index.ts";
import { EgressBlockedError } from "../../connectors/egress-guard.ts";
import { setConnectorHealth } from "../../connectors/health-state.ts";
import type { Db, Executor } from "../../db/client.ts";
import { connectorMcpSessions, connectors } from "../../db/schema/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";

export const MCP_CREDENTIAL_ENVIRONMENT = "prod" as const;

export interface McpAuthConfig {
  kind:
    | "none"
    | "bearer"
    | "basic"
    | "header"
    | "oauth2"
    | "oauth2_client_credentials"
    | "oauth2_private_key_jwt";
  issuer?: string;
  client_id?: string;
  scope?: string;
  algorithm?: string;
}

export const McpAuthConfigSchema = z
  .object({
    kind: z.enum([
      "none",
      "bearer",
      "basic",
      "header",
      "oauth2",
      "oauth2_client_credentials",
      "oauth2_private_key_jwt",
    ]),
    issuer: z.string().url().optional(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
    algorithm: z.string().optional(),
  })
  .strict();

export interface McpConnectorRow {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  transport: "http" | "sse" | "stdio";
  url: string;
  auth: McpAuthConfig;
  environment: "dev" | "prod";
  enabled: boolean;
}

const MCP_CONNECTOR_COLUMNS = {
  id: connectors.id,
  tenant_id: connectors.tenant_id,
  slug: connectors.slug,
  display_name: connectors.display_name,
  driver: connectors.driver,
  environment: connectors.environment,
  base_url: connectors.base_url,
  config: connectors.config,
  enabled: connectors.enabled,
} as const;

type McpConnectorColumns = {
  [K in keyof typeof MCP_CONNECTOR_COLUMNS]: K extends "config"
    ? Record<string, unknown>
    : K extends "enabled"
      ? boolean
      : K extends "base_url"
        ? string | null
        : string;
};

function projectMcpConnector(row: McpConnectorColumns): McpConnectorRow | null {
  if (row.driver !== "mcp" || !row.base_url) return null;
  const block = (row.config as { mcp?: { transport?: unknown; auth?: unknown } }).mcp ?? {};
  const transport =
    block.transport === "sse" || block.transport === "stdio" || block.transport === "http"
      ? block.transport
      : "http";
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    transport,
    url: row.base_url,
    auth: parseAuthConfig((block.auth as Record<string, unknown> | undefined) ?? null),
    environment: row.environment as "dev" | "prod",
    enabled: row.enabled,
  };
}

export async function getMcpConnector(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<McpConnectorRow | null> {
  const rows = await db
    .select(MCP_CONNECTOR_COLUMNS)
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, id),
        eq(connectors.driver, "mcp"),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? projectMcpConnector(row) : null;
}

export async function listConnectableMcpConnectorsForTenant(
  db: Executor,
  tenant_id: string,
): Promise<McpConnectorRow[]> {
  const rows = await db
    .select(MCP_CONNECTOR_COLUMNS)
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.driver, "mcp"),
        eq(connectors.enabled, true),
        isNull(connectors.deleted_at),
      ),
    );
  return rows.map(projectMcpConnector).filter((r): r is McpConnectorRow => r !== null);
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)]+/gi;
const MAX_UPSTREAM_DETAIL_CHARS = 300;

export function redactUpstreamDetail(message: string): string {
  const originOnly = message.replace(URL_IN_TEXT_RE, (match) => {
    try {
      const u = new URL(match);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "[url]";
    }
  });
  const sanitized = scrubString(originOnly);
  return sanitized.length > MAX_UPSTREAM_DETAIL_CHARS
    ? `${sanitized.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}…`
    : sanitized;
}

export class McpPreflightError extends Error {
  constructor(
    readonly error_code: McpPreflightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpPreflightError";
  }
}

export type McpPreflightErrorCode =
  | "credential_missing"
  | "credential_invalid"
  | "config_incomplete"
  | "mcp_transport_unsupported";

export type McpHandshakeErrorCode =
  | McpPreflightErrorCode
  | "egress_blocked"
  | "auth_rejected"
  | "rate_limited"
  | "resource_not_found"
  | "vendor_degraded"
  | "mcp_handshake_failed";

export interface McpHandshakeFault {
  error_code: McpHandshakeErrorCode;
  reason: string;
}

export const UNAUTHORIZED_HANDSHAKE_MESSAGE = "authorization required";

const HTTP_STATUS_IN_TEXT_RE = /\bHTTP\s+(\d{3})\b/;

export function classifyMcpHandshakeFailure(err: unknown, endpoint_url: string): McpHandshakeFault {
  const host = endpointHostOf(endpoint_url);
  const fault = (error_code: McpHandshakeErrorCode, sentence: string): McpHandshakeFault => ({
    error_code,
    reason: capped(sentence),
  });
  if (err instanceof EgressBlockedError) {
    return fault(
      "egress_blocked",
      `The engine refused to open an MCP session to ${host}: ${err.reason}.`,
    );
  }
  if (err instanceof McpPreflightError) {
    return fault(err.error_code, `The MCP handshake with ${host} never started: ${err.message}`);
  }
  const raw_error = err instanceof Error ? err.message : String(err);
  const status = Number.parseInt(HTTP_STATUS_IN_TEXT_RE.exec(raw_error)?.[1] ?? "", 10);
  const at = `(HTTP ${status})`;
  if (err instanceof UnauthorizedError || raw_error === UNAUTHORIZED_HANDSHAKE_MESSAGE) {
    return fault(
      "auth_rejected",
      `The external MCP server at ${host} required authorization the connector could not present.`,
    );
  }
  if (status === 401 || status === 403) {
    return fault(
      "auth_rejected",
      `The external MCP server at ${host} rejected the connector's credential during the handshake ${at}.`,
    );
  }
  if (status === 429) {
    return fault(
      "rate_limited",
      `The external MCP server at ${host} rate-limited the handshake ${at}.`,
    );
  }
  if (status === 404 || status === 410) {
    return fault(
      "resource_not_found",
      `The external MCP server at ${host} served no MCP endpoint at the configured URL ${at}.`,
    );
  }
  if (status >= 500 && status <= 599) {
    return fault(
      "vendor_degraded",
      `The external MCP server at ${host} failed the handshake with a server error ${at}.`,
    );
  }
  return fault(
    "mcp_handshake_failed",
    `The MCP handshake with ${host} did not complete. The upstream response is in the engine log for this connector.`,
  );
}

function capped(sentence: string): string {
  return sentence.length > MAX_UPSTREAM_DETAIL_CHARS
    ? `${sentence.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}…`
    : sentence;
}

function endpointHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured endpoint";
  }
}

function formatLastError(fault: McpHandshakeFault): string {
  return `[${fault.error_code}] ${fault.reason}`;
}

export async function recordMcpHandshakeState(
  db: Db,
  row: McpConnectorRow,
  tools_manifest_hash: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(connectorMcpSessions)
      .values({
        connector_id: row.id,
        tenant_id: row.tenant_id,
        tools_manifest_hash,
        last_handshake_at: now,
        consecutive_failures: 0,
        backoff_until: null,
      })
      .onConflictDoUpdate({
        target: connectorMcpSessions.connector_id,
        set: {
          tools_manifest_hash,
          last_handshake_at: now,
          consecutive_failures: 0,
          backoff_until: null,
          updated_at: now,
        },
      });
    await tx
      .update(connectors)
      .set({ last_error: null, updated_at: now })
      .where(and(eq(connectors.tenant_id, row.tenant_id), eq(connectors.id, row.id)));
  });
  await clearMcpConnectorFailure(db, row);
}

export async function getMcpSessionBackoff(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<{ consecutive_failures: number; backoff_until: Date | null } | null> {
  const rows = await db
    .select({
      consecutive_failures: connectorMcpSessions.consecutive_failures,
      backoff_until: connectorMcpSessions.backoff_until,
    })
    .from(connectorMcpSessions)
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, tenant_id),
        eq(connectorMcpSessions.connector_id, connector_id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function parkMcpConnectorFailure(
  db: Db,
  row: McpConnectorRow,
  error: unknown,
  backoffFor: (failures: number) => Date,
): Promise<number> {
  const fault = classifyMcpHandshakeFailure(error, row.url);
  const persistedError = formatLastError(fault);
  const now = new Date();
  const failures = await db.transaction(async (tx) => {
    await tx
      .update(connectors)
      .set({ last_error: persistedError, updated_at: now })
      .where(and(eq(connectors.tenant_id, row.tenant_id), eq(connectors.id, row.id)));
    const result = await tx.execute<{ consecutive_failures: number }>(sql`
      INSERT INTO "connector_mcp_sessions"
        ("connector_id", "tenant_id", "consecutive_failures")
      VALUES (${row.id}, ${row.tenant_id}, 1)
      ON CONFLICT ("connector_id") DO UPDATE
        SET "consecutive_failures" = "connector_mcp_sessions"."consecutive_failures" + 1,
            "updated_at" = ${now}
      RETURNING "consecutive_failures"
    `);
    return Number(result.rows[0]?.consecutive_failures ?? 1);
  });
  await db
    .update(connectorMcpSessions)
    .set({ backoff_until: backoffFor(failures) })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, row.tenant_id),
        eq(connectorMcpSessions.connector_id, row.id),
      ),
    );
  await setConnectorHealth(
    db,
    { id: row.id, tenant_id: row.tenant_id, slug: row.slug },
    {
      state: "degraded",
      reason: fault.reason,
      error_code: fault.error_code,
    },
  );
  return failures;
}

export async function clearMcpConnectorFailure(db: Db, row: McpConnectorRow): Promise<void> {
  await setConnectorHealth(
    db,
    { id: row.id, tenant_id: row.tenant_id, slug: row.slug },
    {
      state: "ok",
      reason: "handshake ok — external MCP server reachable",
    },
  );
}

export async function recordMcpNegotiation(
  db: Executor,
  row: McpConnectorRow,
  negotiation: {
    protocol_version: string | null;
    server_capabilities: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .update(connectorMcpSessions)
    .set({
      negotiated_protocol_version: negotiation.protocol_version,
      server_capabilities: negotiation.server_capabilities,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, row.tenant_id),
        eq(connectorMcpSessions.connector_id, row.id),
      ),
    );
}

export function parseAuthConfig(raw: Record<string, unknown> | null): McpAuthConfig {
  if (!raw) return { kind: "none" };
  const parsed = McpAuthConfigSchema.parse(raw);
  const out: McpAuthConfig = { kind: parsed.kind };
  if (parsed.issuer !== undefined) out.issuer = parsed.issuer;
  if (parsed.client_id !== undefined) out.client_id = parsed.client_id;
  if (parsed.scope !== undefined) out.scope = parsed.scope;
  if (parsed.algorithm !== undefined) out.algorithm = parsed.algorithm;
  return out;
}

export async function updateMcpAuthConfig(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  auth: McpAuthConfig,
  auditCtx: { actor_id: string | null; request_source: RequestSource },
): Promise<void> {
  const parsed = McpAuthConfigSchema.parse(auth);
  const [row] = await db
    .update(connectors)
    .set({
      config: sql`jsonb_set(
        jsonb_set(coalesce(${connectors.config}, '{}'::jsonb), '{mcp}', coalesce(${connectors.config} -> 'mcp', '{}'::jsonb), true),
        '{mcp,auth}', ${JSON.stringify(parsed)}::jsonb, true)`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, connector_id),
        eq(connectors.driver, "mcp"),
      ),
    )
    .returning({ slug: connectors.slug });
  if (!row) return;
  await recordConnectorMcpClientRegistered({
    tenant_id,
    actor_id: auditCtx.actor_id,
    connector_id,
    connector_slug: row.slug,
    client_id: parsed.client_id ?? null,
    request_source: auditCtx.request_source,
    executor: db,
  });
}
