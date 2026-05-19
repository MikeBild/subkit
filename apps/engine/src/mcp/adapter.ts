// MCP-surface adapter for the unified tool dispatcher.
//
// Renders ToolDescriptor into MCP `Tool` shape and ToolEnvelope into
// MCP JSON-RPC `{isError, content[]}`. The server.ts wiring switches to
// this adapter as part of the cutover; until then the legacy
// `capabilities/tools.ts` path still drives `tools/list` + `tools/call`.
//
// Three concerns the adapter merges:
//   1. Unified-registry tools (static + conversation tools).
//   2. wf.<slug> dynamic workflow tools — still listed via the existing
//      `listWorkflowTools` helper because the workflow→tool synthesis
//      is workflow-subsystem logic, not registry logic.
//   3. conversation.* session-management tools (start/append/commit/
//      respond_elicitation) — these are MCP-only RPCs over the
//      conversation service, not LLM tool palette items; their list
//      + call path lives in capabilities/conversations.ts.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { EngineClient } from "../engine-client/index.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../tools/index.ts";
import type { ToolDescriptor, ToolEnvelope, ToolInvocation } from "../tools/types.ts";
import { buildConversationToolMeta } from "./capabilities/tool-meta.ts";

// Zod schema → MCP JSON schema. Matches the helper in tenant-tools.ts;
// kept local to the adapter so the dispatcher stays agnostic of MCP.
function zodToMcpSchema(schema: unknown): Tool["inputSchema"] {
  try {
    if (schema && typeof schema === "object" && "parse" in (schema as object)) {
      // biome-ignore lint/suspicious/noExplicitAny: z.toJSONSchema typing
      const anyZ = z as any;
      if (typeof anyZ.toJSONSchema === "function") {
        const json = anyZ.toJSONSchema(schema, { target: "jsonSchema7" });
        if (json && typeof json === "object" && (json as { type?: unknown }).type === "object") {
          return json as Tool["inputSchema"];
        }
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

function descriptorToMcpTool(d: ToolDescriptor): Tool {
  const tool: Tool = {
    name: d.name,
    description: d.description,
    inputSchema: zodToMcpSchema(d.inputSchema),
  };
  // Attach _meta.subkit.* hints — keep parity with the legacy tenant.*
  // alias path (capabilities/tenant-tools.ts:77) so the same conversation
  // tool exposes identical metadata whether reached via its bare name
  // or its tenant.<name> alias. Disabled descriptors get the explicit
  // reason MERGED with the conversation-tool meta so clients can still
  // see the category for routing decisions.
  const baseMeta = buildConversationToolMeta(d.category, d.name);
  const subkitMeta: Record<string, unknown> = { ...baseMeta.subkit };
  if (d.disabled) {
    subkitMeta.disabled = { reason: d.disabled.reason };
  }
  (tool as Tool & { _meta?: Record<string, unknown> })._meta = { subkit: subkitMeta };
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
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope.confirm) }],
      _meta: { subkit: { confirm: envelope.confirm } },
    };
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
  // broke those joins silently. We mint a real UUID and log it with
  // the `mcp_stub` source so analytics can join from audit metadata
  // back to this synthetic session if needed.
  const stubConversationId = crypto.randomUUID();
  return {
    db: opts.db,
    tenant_id: opts.principal.tenant_id,
    conversation_id: stubConversationId,
    actor_id: opts.principal.id,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/** Top-level adapter call — register this as the MCP tools/call handler.
 *  Wraps the dispatcher and renders the envelope to the MCP response
 *  shape. The server.ts cutover replaces the in-place dispatch in
 *  capabilities/tools.ts with a thin call to this function. */
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
