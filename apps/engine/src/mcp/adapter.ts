// MCP-surface adapter for the unified tool dispatcher.
//
// Renders ToolDescriptor into MCP `Tool` shape and ToolEnvelope into
// MCP JSON-RPC `{isError, content[]}`. This adapter drives `tools/list`
// and `tools/call` (wired in via capabilities/tools.ts).
//
// Three concerns the adapter merges:
//   1. Unified-registry tools (static + conversation tools).
//   2. wf_<slug> dynamic workflow tools — still listed via the existing
//      `listWorkflowTools` helper because the workflow→tool synthesis
//      is workflow-subsystem logic, not registry logic.
//   3. conversation_* session-management tools (start/append/commit/
//      respond_elicitation) — these are MCP-only RPCs over the
//      conversation service, not LLM tool palette items; their list
//      + call path lives in capabilities/conversations.ts.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { EngineClient } from "../engine-client/index.ts";
import { logger as mcpStubLogger } from "../logging/logger.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../tools/index.ts";
import type { ToolDescriptor, ToolEnvelope, ToolInvocation } from "../tools/types.ts";
import {
  alwaysLoadTool,
  buildConversationToolMeta,
  buildToolAnnotations,
} from "./capabilities/tool-meta.ts";
import { zodToJsonSchema7 } from "./json-schema.ts";

// Zod schema → MCP JSON schema, via the shared boundary helper so the
// emitted shape matches every other tool surface.
function zodToMcpSchema(schema: unknown): Tool["inputSchema"] {
  try {
    if (schema && typeof schema === "object" && "parse" in (schema as object)) {
      const json = zodToJsonSchema7(schema as ZodType);
      if (json && typeof json === "object" && (json as { type?: unknown }).type === "object") {
        return json as Tool["inputSchema"];
      }
    }
    // Plain JSON Schema from static tools or workflow-derived tools.
    if (schema && typeof schema === "object" && (schema as { type?: string }).type === "object") {
      return schema as Tool["inputSchema"];
    }
  } catch {
    // fall through
  }
  return { type: "object", properties: {} };
}

// Acronyms / proper nouns that must not be naively Title-Cased when deriving a
// human-readable `title` from a snake_case tool `name`.
const TITLE_ACRONYMS: Readonly<Record<string, string>> = {
  oauth: "OAuth",
  rbac: "RBAC",
  graphql: "GraphQL",
  mcp: "MCP",
  llm: "LLM",
  api: "API",
  url: "URL",
  id: "ID",
  sql: "SQL",
  csv: "CSV",
  json: "JSON",
  html: "HTML",
  db: "DB",
  rid: "RID",
};

/**
 * Derive an MCP `title` (human display name) from a machine `name`. MCP clients
 * render `title` when present and fall back to the raw `name` otherwise — so
 * `title: d.name` (the prior behaviour) made tools show as `analyze_scrape_target`
 * / `call_connector` in claude.ai. `name` is the snake_case machine id; `title`
 * is the Title-Cased label.
 */
function titleFromName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => TITLE_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function descriptorToMcpTool(d: ToolDescriptor): Tool {
  const tool: Tool = {
    name: d.name,
    title: titleFromName(d.name),
    description: d.description,
    inputSchema: zodToMcpSchema(d.inputSchema),
    // Spec-standard hints so a generic strict MCP client can tell a
    // read tool from a write and permit the call without its own gate.
    annotations: buildToolAnnotations(d.category, d.name),
    execution: {
      taskSupport: d.name.startsWith("conversation_") ? "optional" : "forbidden",
    },
  };
  // Attach _meta.subkit.* hints from the one builder every MCP surface shares
  // (capabilities/tool-meta.ts), so a tool's advertised category / confirm /
  // destructive metadata cannot drift between listings. Disabled descriptors
  // get the explicit reason MERGED with the conversation-tool meta so clients
  // can still see the category for routing decisions.
  const baseMeta = buildConversationToolMeta(d.category, d.name);
  const subkitMeta: Record<string, unknown> = { ...baseMeta.subkit };
  if (d.disabled) {
    subkitMeta.disabled = { reason: d.disabled.reason };
  }
  (tool as Tool & { _meta?: Record<string, unknown> })._meta = {
    subkit: subkitMeta,
    // Vendor-standard defer-loading exemption (Claude Code tool search).
    ...(alwaysLoadTool(d.name) ? { "anthropic/alwaysLoad": true } : {}),
  };
  return tool;
}

/** Render the unified registry into MCP `Tool[]` for a given principal. */
export function listToolsViaRegistry(opts: {
  principal: ResolvedPrincipal;
  mcpMode: "product" | "authoring" | "admin";
  readOnly: boolean;
}): Tool[] {
  const descriptors = getUnifiedRegistry().list({
    surface: "mcp",
    mcpMode: opts.mcpMode,
    readOnly: opts.readOnly,
  });
  return descriptors.map(descriptorToMcpTool);
}

/** Render a ToolEnvelope into the MCP `tools/call` response shape. */
export function envelopeToMcpResponse(envelope: ToolEnvelope): {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  _meta?: Record<string, unknown>;
} {
  if (envelope.status === "ok") {
    // status:'ok' may carry a pause if the underlying tool emitted an
    // elicitation. Mirror the chat-side back-conversion so the same
    // signal reaches both surfaces. Surfacing pause only on
    // status:'paused' would silently drop it on the ok+pause shape that
    // conversation tools like save_workflow_draft return.
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope.data) }],
      ...(envelope.pause ? { _meta: { subkit: { paused: envelope.pause } } } : {}),
    };
  }
  if (envelope.status === "error") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error_code: envelope.error_code,
            message: envelope.message,
            details: envelope.details,
            next_best_actions: envelope.next_best_actions,
          }),
        },
      ],
    };
  }
  if (envelope.status === "needs_confirm") {
    // Unreachable on the MCP surface. `policyDecide` collapses
    // `confirm_before_execution` to `proceed` for `surface:"mcp"` (see
    // tools/policy.ts): the client's native `destructiveHint` dialog is the
    // human gate, and every MCP-reachable confirm-capable tool advertises it
    // (mcp/capabilities/tool-meta.ts, pinned by tools-list.test.ts). If this
    // ever fires, a confirm-capable tool reached MCP WITHOUT an annotation gate
    // — a governance regression to fix at the source, not a renderable state
    // (there is no in-band grant channel over MCP to point a caller at).
    throw new Error(
      `MCP dispatch returned needs_confirm for ${envelope.confirm.tool}: MCP writes are gated ` +
        "by the client's destructiveHint dialog, not a server confirm — this tool must advertise it.",
    );
  }
  if (envelope.status === "paused") {
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope.pause) }],
      _meta: { subkit: { paused: envelope.pause } },
    };
  }
  // not_available_on_surface
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error_code: "not_available_on_surface",
          reason: envelope.reason,
        }),
      },
    ],
    _meta: { subkit: { not_available_on_surface: { reason: envelope.reason } } },
  };
}

/** Build an MCP-context-stub `ToolContext` so conversation tools can
 *  execute against an MCP caller without a real conversation session. */
export function buildMcpStubCtx(opts: { db: Db; principal: ResolvedPrincipal }): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: opts.principal.tenant_id,
    actor_id: opts.principal.id,
    actor_type: opts.principal.kind === "user" ? "user" : "system_account",
    db: opts.db,
  });
  // conversation_id MUST be a valid UUID — several conversation tools
  // do FK joins against conversations(id) (e.g. inspect_authoring_context,
  // load_skill, save_connector_draft). The legacy `mcp-<uuid>` string
  // broke those joins silently. Mint a real UUID and emit a structured
  // log line tagged `mcp_stub_ctx_built` so analytics can join from
  // audit metadata (which records conversation_id) back to the
  // synthetic session this stub represents.
  const stubConversationId = crypto.randomUUID();
  mcpStubLogger.info({
    module: "mcp",
    action: "mcp.stub_ctx.built",
    msg: "synthetic ToolContext minted for MCP-only dispatch",
    source: "mcp_stub",
    conversation_id: stubConversationId,
    tenant_id: opts.principal.tenant_id,
    principal_id: opts.principal.id,
  });
  return {
    db: opts.db,
    tenant_id: opts.principal.tenant_id,
    conversation_id: stubConversationId,
    actor_id: opts.principal.id,
    principal: opts.principal,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/** Top-level adapter call — register this as the MCP tools/call handler.
 *  Wraps the dispatcher and renders the envelope to the MCP response
 *  shape.
 *
 *  Human-in-the-loop over MCP is the CLIENT's native `destructiveHint` dialog:
 *  a trusted client (claude.ai, ChatGPT) renders a blocking, per-call approval
 *  BEFORE the call reaches the engine, so `policyDecide` takes no server-side
 *  confirm on `surface:"mcp"` (it would be redundant and has no in-band grant
 *  channel). Every MCP-reachable write advertises `destructiveHint:true`
 *  (mcp/capabilities/tool-meta.ts) so the client gate always fires; the adapter
 *  therefore never renders a `needs_confirm` envelope (see above).
 *
 *  The adapter itself makes no approval decision — it only renders. */
export async function callToolViaDispatcher(opts: {
  db: Db;
  principal: ResolvedPrincipal;
  mcpMode: "product" | "authoring" | "admin";
  readOnly: boolean;
  invocation: ToolInvocation;
}): Promise<ReturnType<typeof envelopeToMcpResponse>> {
  const envelope = await dispatchTool(
    {
      registry: getUnifiedRegistry(),
      db: opts.db,
      principal: opts.principal,
      buildMcpStubCtx: () => buildMcpStubCtx({ db: opts.db, principal: opts.principal }),
      mcpMode: opts.mcpMode,
      readOnly: opts.readOnly,
    },
    opts.invocation,
  );
  return envelopeToMcpResponse(envelope);
}
