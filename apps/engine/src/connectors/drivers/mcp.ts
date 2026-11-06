import type { AuditActorType } from "../../audit/types.ts";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import type { RemoteToolDescriptor } from "../../mcp/client/manifest.ts";
import {
  connectServerById,
  type InvokeRemoteToolResult,
  invokeRemoteTool,
  probeTransientMcpServer,
} from "../../mcp/client/pool.ts";
import { type McpConnectorRow, parseAuthConfig } from "../../mcp/client/registry.ts";
import { MCP_WIRE_METHOD, type RemoteCall } from "../../mcp/client/remote-call.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { McpConnectorConfigSchema } from "../config-schemas.ts";
import type { EgressInput } from "../egress.ts";
import { CONNECTOR_SLUG_RE, type ConnectorView } from "../types.ts";
import type { DriverProbeResult, ProbeErrorCode } from "./index.ts";

const MCP_TOOL_PREFIX = "mcp_";
const MCP_NAMESPACE_SEP = "__";

export const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MCP_TOOL_NAME_MAX = 64;

export class McpToolNameError extends Error {
  constructor(
    message: string,
    public readonly reason: "invalid_slug" | "invalid_remote_tool" | "composed_too_long",
  ) {
    super(message);
    this.name = "McpToolNameError";
  }
}

export function buildMcpToolName(slug: string, remote_tool: string): string {
  if (slug.includes(MCP_NAMESPACE_SEP) || !CONNECTOR_SLUG_RE.test(slug)) {
    throw new McpToolNameError(
      `connector slug '${slug}' cannot namespace an MCP tool — it must match ${CONNECTOR_SLUG_RE.source} and contain no '__'`,
      "invalid_slug",
    );
  }
  if (remote_tool.includes(MCP_NAMESPACE_SEP) || !MCP_TOOL_NAME_RE.test(remote_tool)) {
    throw new McpToolNameError(
      `remote tool name '${remote_tool}' is not addressable — it must match ${MCP_TOOL_NAME_RE.source} and contain no '__'`,
      "invalid_remote_tool",
    );
  }
  const composed = `${MCP_TOOL_PREFIX}${slug}${MCP_NAMESPACE_SEP}${remote_tool}`;
  if (composed.length > MCP_TOOL_NAME_MAX) {
    throw new McpToolNameError(
      `'${composed}' is ${composed.length} chars — over the ${MCP_TOOL_NAME_MAX}-char tool-name limit; shorten the connector slug`,
      "composed_too_long",
    );
  }
  return composed;
}

export function parseMcpToolName(name: string): { slug: string; remote_tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf(MCP_NAMESPACE_SEP);
  if (at <= 0) return null;
  const slug = rest.slice(0, at);
  const remote_tool = rest.slice(at + MCP_NAMESPACE_SEP.length);
  if (slug.length === 0 || remote_tool.length === 0) return null;
  if (remote_tool.includes(MCP_NAMESPACE_SEP)) return null;
  return { slug, remote_tool };
}

interface McpDriverConfig {
  transport: "http" | "sse";
  remote_tool_call_timeout_ms?: number;
}

function parseMcpConnectorConfig(connector: ConnectorView): McpDriverConfig {
  const parsed = McpConnectorConfigSchema.safeParse(connector.config ?? {});
  if (!parsed.success) {
    throw Object.assign(new Error(`invalid mcp connector config for ${connector.slug}`), {
      code: "connector_config_invalid",
      details: parsed.error.issues.map(
        (i) => `${i.path.length > 0 ? i.path.join(".") : "config"}: ${i.message}`,
      ),
    });
  }
  const block = (parsed.data as { mcp: { transport: "http" | "sse"; [k: string]: unknown } }).mcp;
  const out: McpDriverConfig = { transport: block.transport };
  if (typeof block.remote_tool_call_timeout_ms === "number") {
    out.remote_tool_call_timeout_ms = block.remote_tool_call_timeout_ms;
  }
  return out;
}

function probeErrorFor(
  reason: "not_found" | "disabled" | "handshake_failed",
  detail: string | null,
): ProbeErrorCode {
  if (reason === "not_found") return "remote_resource_not_found";
  if (reason === "disabled") return "connector_disabled";
  if (detail && /authorization required|\b401\b|unauthorized/i.test(detail)) {
    return "credential_invalid";
  }
  if (detail && /no client credential|missing client_secret|private key credential/i.test(detail)) {
    return "credential_missing";
  }
  return "unknown_upstream_error";
}

export interface McpProbeManifest {
  tools: RemoteToolDescriptor[];
  instructions: string | null;
}

type McpProbeResult = DriverProbeResult & { manifest?: McpProbeManifest };

export async function probeMcpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
  requestSource?: RequestSource;
  actor_id?: string | null;
  actor_type?: AuditActorType;
}): Promise<McpProbeResult> {
  const start = Date.now();

  if (p.credential_override !== undefined) {
    try {
      const cfg = parseMcpConnectorConfig(p.connector);
      const rawAuth = (p.connector.config as { mcp?: { auth?: unknown } } | null | undefined)?.mcp
        ?.auth;
      const row: McpConnectorRow = {
        id: p.connector.id,
        tenant_id: p.tenant_id,
        slug: p.connector.slug,
        display_name: p.connector.display_name,
        transport: cfg.transport,
        url: p.connector.base_url ?? "",
        auth: parseAuthConfig((rawAuth as Record<string, unknown> | undefined) ?? null),
        environment: p.connector.environment,
        enabled: true,
      };
      const outcome = await probeTransientMcpServer({
        db: p.db,
        tenant_id: p.tenant_id,
        row,
        credential: p.credential_override,
        ...(p.requestSource ? { requestSource: p.requestSource } : {}),
      });
      const latency_ms = Date.now() - start;
      if (!outcome.ok) {
        const preflightProbeCode =
          outcome.preflight_error_code === "credential_missing" ||
          outcome.preflight_error_code === "credential_invalid"
            ? outcome.preflight_error_code
            : null;
        return {
          ok: false,
          latency_ms,
          detail: outcome.detail,
          error_code: preflightProbeCode ?? probeErrorFor("handshake_failed", outcome.detail),
        };
      }
      return {
        ok: true,
        latency_ms,
        detail: `handshake ok — ${outcome.tool_count} tool(s)`,
        manifest: { tools: outcome.tools, instructions: outcome.instructions },
      };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
        error_code: "unknown_upstream_error",
      };
    }
  }

  let transport: McpDriverConfig["transport"];
  try {
    transport = parseMcpConnectorConfig(p.connector).transport;
  } catch (err) {
    const details = (err as { details?: string[] })?.details ?? [];
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: details.length > 0 ? `${message}: ${details.join("; ")}` : message,
      error_code: "unknown_upstream_error",
    };
  }
  if (transport !== "http") {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: `mcp transport '${transport}' is not served — re-register this connector over streamable HTTP`,
      error_code: "unknown_upstream_error",
    };
  }

  try {
    const outcome = await connectServerById(p.db, p.tenant_id, p.connector.id, {
      environment: p.connector.environment,
      ...(p.requestSource ? { requestSource: p.requestSource } : {}),
      actor_id: p.actor_id ?? null,
      ...(p.actor_type ? { actor_type: p.actor_type } : {}),
    });
    const latency_ms = Date.now() - start;
    if (!outcome.ok) {
      logger.warn({
        module: "connector",
        action: "mcp.probe.failed",
        connector_id: p.connector.id,
        latency_ms,
        reason: outcome.reason,
      });
      return {
        ok: false,
        latency_ms,
        detail:
          outcome.reason === "not_found"
            ? "no MCP session is registered for this connector"
            : outcome.reason === "disabled"
              ? "this MCP server is disabled — enable it before probing"
              : (outcome.detail ?? "handshake failed"),
        error_code: probeErrorFor(outcome.reason, outcome.detail),
      };
    }
    logger.debug({
      module: "connector",
      action: "mcp.probe.completed",
      connector_id: p.connector.id,
      ok: true,
      latency_ms,
      tool_count: outcome.tools.tools.length,
    });
    return {
      ok: true,
      latency_ms,
      detail: `handshake ok — ${outcome.tools.tools.length} tool(s)`,
    };
  } catch (err) {
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "mcp.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      ...errorFields(err),
    });
    return {
      ok: false,
      latency_ms,
      detail: err instanceof Error ? err.message : String(err),
      error_code: "unknown_upstream_error",
    };
  }
}

export interface McpInvokeResult {
  ok: boolean;
  content: unknown;
  structured_content?: unknown;
  bytes: number;
  failure: InvokeRemoteToolResult["failure"];
  wire_method: string;
  tool_name?: string;
}

export function mcpEgressInput(p: {
  executor: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  connector: { id: string; slug: string; url: string | null };
  call: RemoteCall;
  source: NonNullable<EgressInput["source"]>;
  execution_id?: string | null;
  workflow_id?: string | null;
  step_id?: string | null;
}): EgressInput {
  return {
    executor: p.executor,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    actor_type: p.actor_type,
    connector_id: p.connector.id,
    connector_slug: p.connector.slug,
    driver: "mcp",
    credential_id: null,
    operation: MCP_WIRE_METHOD[p.call.operation],
    url: p.connector.url,
    source: p.source,
    ...(p.execution_id !== undefined ? { execution_id: p.execution_id } : {}),
    ...(p.workflow_id !== undefined ? { workflow_id: p.workflow_id } : {}),
    ...(p.step_id !== undefined ? { step_id: p.step_id } : {}),
  };
}

export async function invokeMcpConnectorCall(p: {
  on_dispatch?: () => void;
  on_credential_use?: (snapshot: CredentialUseSnapshot) => Promise<void>;
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  connector: ConnectorView;
  call: RemoteCall;
  requestSource?: RequestSource;
  signal?: AbortSignal;
}): Promise<McpInvokeResult> {
  const tool_name =
    p.call.operation === "call_tool" ? buildMcpToolName(p.connector.slug, p.call.tool) : undefined;
  const cfg = parseMcpConnectorConfig(p.connector);
  const res = await invokeRemoteTool({
    ...(p.on_dispatch ? { on_dispatch: p.on_dispatch } : {}),
    ...(p.on_credential_use ? { on_credential_use: p.on_credential_use } : {}),
    db: p.db,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    actor_type: p.actor_type,
    connector_id: p.connector.id,
    connector_slug: p.connector.slug,
    call: p.call,
    environment: p.connector.environment,
    ...(p.requestSource ? { requestSource: p.requestSource } : {}),
    ...(p.signal ? { signal: p.signal } : {}),
    ...(cfg.remote_tool_call_timeout_ms !== undefined
      ? { timeout_ms: cfg.remote_tool_call_timeout_ms }
      : {}),
  });
  return {
    ok: res.ok,
    content: res.content,
    ...(res.structured_content !== undefined ? { structured_content: res.structured_content } : {}),
    bytes: res.bytes,
    failure: res.failure,
    wire_method: MCP_WIRE_METHOD[p.call.operation],
    ...(tool_name !== undefined ? { tool_name } : {}),
  };
}
