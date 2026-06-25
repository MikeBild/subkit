// MCP-surface adapter for the unified tool dispatcher.
//
// Renders ToolDescriptor into MCP `Tool` shape and ToolEnvelope into
// MCP JSON-RPC `{isError, content[]}`. This adapter drives `tools/list`
// and `tools/call` (wired in via capabilities/tools.ts).
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
import type { ZodType } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { EngineClient } from "../engine-client/index.ts";
import { logger as mcpStubLogger } from "../logging/logger.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../tools/index.ts";
import { SK_CONFIRM_ID_META_KEY, SK_CONFIRM_META_KEY } from "../tools/policy.ts";
import type {
  ConfirmEnvelope,
  ToolDescriptor,
  ToolEnvelope,
  ToolInvocation,
} from "../tools/types.ts";
import { buildConversationToolMeta, buildToolAnnotations } from "./capabilities/tool-meta.ts";
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

function descriptorToMcpTool(d: ToolDescriptor): Tool {
  const tool: Tool = {
    name: d.name,
    description: d.description,
    inputSchema: zodToMcpSchema(d.inputSchema),
    // Spec-standard hints so a generic MCP client (ChatGPT/codex) can tell a
    // read tool from a write and permit the call without its own gate.
    annotations: buildToolAnnotations(d.category, d.name),
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
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/**
 * Resolver the tools/call handler supplies when the connected MCP client
 * advertises the `elicitation` capability. Given the confirm envelope, it
 * issues a server→client `elicitation/create` confirm prompt and resolves
 * to the operator's decision (`true` = approved). See
 * `callToolViaDispatcher` for why this is the only model-only-client path
 * that can satisfy a `confirm_before_execution` gate.
 */
export type ConfirmResolver = (confirm: ConfirmEnvelope) => Promise<boolean>;

/** Top-level adapter call — register this as the MCP tools/call handler.
 *  Wraps the dispatcher and renders the envelope to the MCP response
 *  shape.
 *
 *  Human-in-the-loop over MCP: a `confirm_before_execution` tool returns a
 *  `needs_confirm` envelope. A claude.ai/ChatGPT *model* cannot set the
 *  transport-level `_meta.sk_confirm` flag the gate looks for — it only
 *  fills the published inputSchema — so the gate is otherwise
 *  unsatisfiable from a model-only client. When the client advertises
 *  elicitation, `confirmResolver` prompts the operator in-band via
 *  `elicitation/create`; on approval we re-dispatch the IDENTICAL call
 *  with the confirm marker set server-side, which lets the dispatcher
 *  proceed and join the APPROVAL_REQUESTED → APPROVAL_APPROVED lifecycle
 *  by `tool_call_id`. Clients without elicitation get the
 *  `_meta.subkit.confirm` envelope and resolve it via the
 *  `confirm_tool_call` fallback tool. */
export async function callToolViaDispatcher(opts: {
  db: Db;
  principal: ResolvedPrincipal;
  mcpMode: "product" | "authoring" | "admin";
  readOnly: boolean;
  invocation: ToolInvocation;
  confirmResolver?: ConfirmResolver;
}): Promise<ReturnType<typeof envelopeToMcpResponse>> {
  const deps = {
    registry: getUnifiedRegistry(),
    db: opts.db,
    principal: opts.principal,
    buildMcpStubCtx: () => buildMcpStubCtx({ db: opts.db, principal: opts.principal }),
    mcpMode: opts.mcpMode,
    readOnly: opts.readOnly,
  };
  const envelope = await dispatchTool(deps, opts.invocation);

  if (envelope.status === "needs_confirm" && opts.confirmResolver) {
    const approved = await opts.confirmResolver(envelope.confirm);
    if (!approved) {
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "declined",
              tool: envelope.confirm.tool,
              tool_call_id: envelope.confirm.tool_call_id,
              message: "Operator declined the confirmation; the call was not executed.",
            }),
          },
        ],
      };
    }
    // Re-issue the identical call with the confirm marker the dispatcher's
    // `isConfirmed` looks for, carrying the original tool_call_id so the
    // APPROVAL_APPROVED audit row joins APPROVAL_REQUESTED.
    const confirmedInvocation: ToolInvocation = {
      ...opts.invocation,
      meta: {
        ...(opts.invocation.meta ?? {}),
        [SK_CONFIRM_META_KEY]: true,
        [SK_CONFIRM_ID_META_KEY]: envelope.confirm.tool_call_id,
      },
    };
    return envelopeToMcpResponse(await dispatchTool(deps, confirmedInvocation));
  }

  return envelopeToMcpResponse(envelope);
}
