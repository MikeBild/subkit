import type { lookup as dnsLookup } from "node:dns/promises";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { assertEgressAllowed, assertEgressAllowedResolved } from "../../connectors/egress-guard.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import {
  capManifest,
  hashManifest,
  listAllRemoteTools,
  parseRemoteManifest,
  type RemoteToolDescriptor,
} from "./manifest.ts";
import {
  CLIENT_CAPABILITIES,
  captureNegotiatedProtocolVersion,
  negotiatedCapabilities,
} from "./negotiation.ts";
import { type McpConnectorRow, McpPreflightError } from "./registry.ts";
import type { RemoteCallClient } from "./remote-call.ts";
import {
  resolveAuthHeaders,
  resolveAuthProvider,
  resolveStaticAuthHeaders,
} from "./session-auth.ts";

export interface McpClientLike extends RemoteCallClient {
  connect(transport: Transport): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<{
    tools: unknown[];
    nextCursor?: string | undefined;
  }>;
  close(): Promise<void>;
  getServerCapabilities?(): ServerCapabilitiesLike | undefined;
  getServerVersion?(): Record<string, unknown> | undefined;
  getInstructions?(): string | undefined;
}

export interface ServerCapabilitiesLike {
  tools?: unknown;
  resources?: unknown;
  prompts?: unknown;
  [key: string]: unknown;
}

export interface NegotiatedServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

type DnsLookup = typeof dnsLookup;

export interface McpSessionFactories {
  makeClient?: (row: McpConnectorRow) => McpClientLike;
  makeTransport?: (row: McpConnectorRow, headers: Record<string, string>) => Transport;
  lookupDns?: DnsLookup;
}

let testFactories: McpSessionFactories | null = null;

export function setMcpSessionFactoriesForTests(factories: McpSessionFactories | null): void {
  testFactories = factories;
}

function buildTransport(
  tenant_id: string,
  row: McpConnectorRow,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
): StreamableHTTPClientTransport | SSEClientTransport {
  const url = new URL(row.url);
  assertEgressAllowed(url, { tenant_id });
  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};
  switch (row.transport) {
    case "http":
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      });
    case "sse":
      return new SSEClientTransport(url, {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
        eventSourceInit: {
          fetch: (target, init) => getDriverFetch()(target, { ...init, headers }),
        },
      });
    case "stdio":
      throw new McpPreflightError(
        "mcp_transport_unsupported",
        "stdio transport is not supported for external MCP servers",
      );
    default: {
      const exhaustive: never = row.transport;
      throw new McpPreflightError(
        "mcp_transport_unsupported",
        `unknown transport: ${String(exhaustive)}`,
      );
    }
  }
}

export interface OpenMcpSessionResult {
  client: McpClientLike;
  tools: RemoteToolDescriptor[];
  manifest_hash: string;
  capabilities: NegotiatedServerCapabilities | null;
  server_version: Record<string, unknown> | null;
  instructions: string | null;
  readNegotiatedProtocolVersion: () => string | null;
}

export async function openMcpSession(
  db: Db,
  tenant_id: string,
  row: McpConnectorRow,
  environment: "dev" | "prod",
  requestSource: RequestSource,
  credentialOverride?: DecryptedCredential | null,
): Promise<OpenMcpSessionResult> {
  const auth = row.auth;
  const headers =
    credentialOverride !== undefined
      ? resolveStaticAuthHeaders(auth, credentialOverride)
      : await resolveAuthHeaders(db, tenant_id, row.id, auth, environment);
  const authProvider: OAuthClientProvider | undefined =
    credentialOverride !== undefined
      ? undefined
      : await resolveAuthProvider(db, tenant_id, row, auth, environment, requestSource);

  await assertEgressAllowedResolved(
    new URL(row.url),
    { tenant_id },
    testFactories?.lookupDns ? { lookupImpl: testFactories.lookupDns } : {},
  );
  const transport =
    testFactories?.makeTransport?.(row, headers) ??
    buildTransport(tenant_id, row, headers, authProvider);
  const readNegotiatedProtocolVersion = captureNegotiatedProtocolVersion(transport as Transport);
  const client: McpClientLike =
    testFactories?.makeClient?.(row) ??
    new Client({ name: "subkit-mcp-client", version: "1" }, { capabilities: CLIENT_CAPABILITIES });
  try {
    await client.connect(transport as Transport);
    const capabilities = negotiatedCapabilities(client);
    const server_version = client.getServerVersion?.() ?? null;
    const instructions = client.getInstructions?.() ?? null;
    const raw =
      capabilities && !capabilities.tools
        ? []
        : await listAllRemoteTools(tenant_id, row.slug, row.id, client);
    const parsed = parseRemoteManifest(raw);
    if (parsed.rejected.length > 0) {
      logger.warn({
        module: "mcp_client",
        action: "manifest.tools_rejected",
        msg: "external MCP server advertised tools that could not be admitted; they are absent from the palette",
        tenant_id,
        connector_id: row.id,
        connector_slug: row.slug,
        rejected_count: parsed.rejected.length,
        rejected: parsed.rejected,
      });
    }
    const tools = capManifest(tenant_id, row.slug, row.id, parsed.tools);
    return {
      client,
      tools,
      manifest_hash: hashManifest(tools),
      capabilities,
      server_version,
      instructions,
      readNegotiatedProtocolVersion,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
