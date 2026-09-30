// MCP driver — a remote Model Context Protocol server addressed as a
// connector.
//
// THIS DRIVER OWNS NO CONNECTION. Read that before assuming symmetry with
// its siblings: http.ts, graphql.ts, s3.ts and postgres.ts each open and
// close their own transport per request, and a reader who ports that shape
// here will write a socket leak. An MCP session is a negotiated handshake
// plus a cached tool manifest — paying for both on every step would make
// the driver slower than the remote it calls — so the live session, the
// manifest cache and the failure backoff all live in
// `mcp/client/pool.ts`, keyed per tenant. This module only translates
// between a `ConnectorView` and that pool.
//
// WHAT THE POOL IS KEYED BY. The pool addresses a session by connector id
// within a tenant bucket. There is no second registry and no second id
// space: `connectors` is the owning table for an MCP server exactly as it
// is for an HTTP one.
//
// TOOL NAMES. A remote tool reaches the model as `mcp_<slug>__<tool>`.
// The grammar is defined here, next to the driver that owns the slug half
// of it, and enforced by `connectors_slug_shape_check` in the database.

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
import { CONNECTOR_SLUG_RE, type ConnectorView } from "../types.ts";
import type { DriverProbeResult, ProbeErrorCode } from "./index.ts";

/** Prefix every remote MCP tool carries in the model-facing palette. */
export const MCP_TOOL_PREFIX = "mcp_";
/** Separator between the connector slug and the remote tool name. */
export const MCP_NAMESPACE_SEP = "__";

/**
 * Charset every tool name the model can see must satisfy. Deliberately
 * bounded at 64: the MCP specification bounds tool names, and the composed
 * `mcp_<slug>__<tool>` is what actually reaches the model — so bounding
 * only the two halves would let a legal slug and a legal remote name
 * compose into an illegal palette entry. No dots: several clients reject
 * them in tool names.
 */
export const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MCP_TOOL_NAME_MAX = 64;

/** Raised when a slug + remote tool pair cannot produce a legal tool name.
 *  Typed so a caller can report the offending half rather than a generic
 *  "invalid tool" the operator cannot act on. */
export class McpToolNameError extends Error {
  constructor(
    message: string,
    public readonly reason: "invalid_slug" | "invalid_remote_tool" | "composed_too_long",
  ) {
    super(message);
    this.name = "McpToolNameError";
  }
}

/**
 * Compose the model-facing name for one remote tool.
 *
 * Rejects rather than truncates. A truncated name still routes — to
 * whichever server happens to share the prefix — and the collision would
 * only surface as a call landing on the wrong remote. Refusing at
 * composition time keeps the palette honest at the cost of one tool.
 */
export function buildMcpToolName(slug: string, remote_tool: string): string {
  // The slug half is checked against the SLUG shape, not the looser
  // tool-name charset. They differ: a tool name may start with `-`, a slug
  // may not, and the slug rule is the one the database enforces. Checking
  // the looser rule here would accept a slug no row could ever hold.
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

/**
 * Split a composed name back into its two halves, or null when it is not
 * one of ours.
 *
 * Splits on the FIRST `__` after the prefix. That is unambiguous only
 * because a slug may not contain `__` — the DB CHECK
 * `connectors_slug_shape_check` is what makes this function correct, and
 * without it the split point would be a guess.
 */
export function parseMcpToolName(name: string): { slug: string; remote_tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf(MCP_NAMESPACE_SEP);
  if (at <= 0) return null;
  const slug = rest.slice(0, at);
  const remote_tool = rest.slice(at + MCP_NAMESPACE_SEP.length);
  if (slug.length === 0 || remote_tool.length === 0) return null;
  // A remote half that still contains `__` means the name was built from a
  // slug that should never have been storable. Refuse rather than pick a
  // split — the alternative is routing to the wrong server.
  if (remote_tool.includes(MCP_NAMESPACE_SEP)) return null;
  return { slug, remote_tool };
}

export interface McpDriverConfig {
  transport: "http" | "sse";
  remote_tool_call_timeout_ms?: number;
}

/**
 * Read the `config.mcp` block off a connector. Throws with the same
 * `connector_config_invalid` shape the write path uses, so a row whose
 * config predates the schema fails with field names rather than a cast
 * error deep inside the pool.
 */
export function parseMcpConnectorConfig(connector: ConnectorView): McpDriverConfig {
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

/** Map a pool handshake outcome onto the shared probe-error vocabulary.
 *  No MCP-SPECIFIC code is added — every consumer of `ProbeErrorCode` would
 *  have to learn it. `connector_disabled` is shared vocabulary about a
 *  connector-level fact any driver reports; the registry refuses a disabled
 *  connector before dispatch, and the pool observes the same fact again for
 *  a caller that reached this driver by another route. */
function probeErrorFor(
  reason: "not_found" | "disabled" | "handshake_failed",
  detail: string | null,
): ProbeErrorCode {
  if (reason === "not_found") return "remote_resource_not_found";
  // NOT `unknown_upstream_error`: nothing upstream was contacted, and an
  // operator reading that code goes looking for a fault in a remote that is
  // fine. The fix is on this side of the boundary.
  if (reason === "disabled") return "connector_disabled";
  // `connectClient` collapses the SDK's UnauthorizedError to this exact
  // sentence before it ever reaches here.
  if (detail && /authorization required|\b401\b|unauthorized/i.test(detail)) {
    return "credential_invalid";
  }
  if (detail && /no client credential|missing client_secret|private key credential/i.test(detail)) {
    return "credential_missing";
  }
  return "unknown_upstream_error";
}

/**
 * Health probe: force one handshake and list the remote's tools.
 *
 * Runs through the pool's own connect path rather than opening a throwaway
 * session, so the probe exercises exactly what a real call exercises —
 * the same egress gate, the same credential resolution, the same drift
 * reconcile — and a probe that passes is evidence about the thing the
 * engine will actually do.
 */
/** What a green handshake learned about the server: its admitted catalog
 *  and free-text instructions. Only the draft (transient) probe carries it —
 *  that is the path that authors a connector. */
export interface McpProbeManifest {
  tools: RemoteToolDescriptor[];
  instructions: string | null;
}

export type McpProbeResult = DriverProbeResult & { manifest?: McpProbeManifest };

export async function probeMcpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  /** An override opens a throwaway session and is never written before a green probe. */
  credential_override?: DecryptedCredential | null;
  requestSource?: RequestSource;
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
    // The per-field issues are the whole value of a config failure — a bare
    // "invalid mcp connector config" names the connector and nothing the
    // author can act on.
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
    // The pool serves streamable HTTP. Saying so here costs one round trip
    // less than letting `buildTransport` throw it at handshake time.
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
    // No `status`: an MCP handshake has no HTTP status, and inventing one
    // would make the probe response lie about what was observed.
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
  /** VERBATIM remote content. The pool does not truncate and neither does
   *  this facade — `get_raw_result` and replay determinism both depend on
   *  the persisted payload being what the server actually sent. */
  content: unknown;
  /** The tool's typed reply, when it sent one. Present only for a tool
   *  that declared an `outputSchema`, because the SDK validated it against
   *  that schema before it reached here — which is the whole reason it is
   *  worth keeping separate from `content`. */
  structured_content?: unknown;
  bytes: number;
  /** Which layer failed, or null on success. Passed straight through from
   *  the pool: the retry loop and the circuit breaker both branch on it,
   *  and re-deriving it from the content would be a guess about a payload
   *  the remote controls. */
  failure: InvokeRemoteToolResult["failure"];
  /** The MCP method that was issued. */
  wire_method: string;
  /** For a tool call, the model-facing name this call would be addressed
   *  by. Absent for the two operations that address no tool. */
  tool_name?: string;
}

/**
 * Perform one MCP operation against a connector's remote server.
 *
 * A facade, not an implementation: the pool decides whether a session
 * already exists, reconnects if not, bounds the call, and audits it.
 */
export async function invokeMcpConnectorCall(p: {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  connector: ConnectorView;
  call: RemoteCall;
  requestSource?: RequestSource;
  /** The step's abort signal. Threaded so aborting a run cancels the
   *  in-flight remote request instead of leaving it to run out its own
   *  timeout while nothing is waiting for it. */
  signal?: AbortSignal;
}): Promise<McpInvokeResult> {
  // Composed before the call so an unaddressable name fails here, where the
  // offending half can be named, rather than as a remote "unknown tool".
  // Only a tool has a palette name: a resource is addressed by URI and a
  // prompt is never exposed as a tool, so neither has one to compose.
  const tool_name =
    p.call.operation === "call_tool" ? buildMcpToolName(p.connector.slug, p.call.tool) : undefined;
  const cfg = parseMcpConnectorConfig(p.connector);
  const res = await invokeRemoteTool({
    db: p.db,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
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
