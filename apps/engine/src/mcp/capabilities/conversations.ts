// MCP conversation tool cluster.
//
// Exposes five tools that drive a full authoring session over the
// MCP transport:
//
//   - conversation.start(connector_id?, workflow_id?, message)
//   - conversation.append(conversation_id, message)
//   - conversation.respond_elicitation(conversation_id, elicitation_id, output, reason?)
//   - conversation.commit(conversation_id)
//
// These are additive to the P7 `wf.<slug>` workflow tools — the list
// handler in `capabilities/tools.ts` concatenates both sets before
// responding to `tools/list`.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import * as svc from "../../conversations/service.ts";
import type { Db } from "../../db/client.ts";
import { MCP_ELICITATION_BLURB } from "../../tools/policy.ts";
import type { ElicitationBridge } from "../elicitation/bridge.ts";
import { toMcpErrorText } from "../error-adapter.ts";

export const CONVERSATION_TOOL_PREFIX = "conversation_";

export function listConversationTools(): Tool[] {
  return [
    {
      name: "conversation_start",
      description: `Start here for ANY connector setup, OAuth authorization, or workflow authoring. Opens a new authoring conversation and drives the first turn — ${MCP_ELICITATION_BLURB}.`,
      inputSchema: {
        type: "object",
        properties: {
          connector_id: { type: "string" },
          workflow_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: "conversation_append",
      description: `Continue an authoring conversation — append a user message and drive another turn. Use this to answer the engine's questions or steer connector/workflow authoring; ${MCP_ELICITATION_BLURB}.`,
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["conversation_id", "message"],
      },
    },
    {
      name: "conversation_commit",
      description: "Return the committed workflow id for a committed conversation.",
      inputSchema: {
        type: "object",
        properties: { conversation_id: { type: "string" } },
        required: ["conversation_id"],
      },
    },
    {
      name: "conversation_respond_elicitation",
      description:
        "Resolve a pending ask_user_* elicitation with the user's answer and resume the loop.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string" },
          elicitation_id: { type: "string" },
          output: {},
          reason: { type: "string" },
        },
        required: ["conversation_id", "elicitation_id", "output"],
      },
    },
  ];
}

export interface HandleConversationToolParams {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  args: Record<string, unknown>;
  /**
   * Permission mode pulled from the tool-call `_meta.sk_permission_mode`.
   * Matches the sk REPL + HTTP surface contract (auto / ask / plan).
   * When undefined, the conversation falls back to the tenant default.
   */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /**
   * MCP-native elicitation bridge for this `tools/call`. Threaded into
   * the conversation loop's `ToolContext` so input-collecting tools
   * surface forms + OAuth prompts directly in the MCP client. Absent on
   * non-MCP callers.
   */
  elicitationBridge?: ElicitationBridge;
}

export interface HandleConversationToolResult {
  isError: boolean;
  content: Array<{ type: "text" } & { text: string }>;
}

export async function handleConversationTool(
  p: HandleConversationToolParams,
): Promise<HandleConversationToolResult> {
  const { db, principal, name, args, permission_mode, elicitationBridge } = p;
  try {
    if (name === "conversation_start") {
      const message = args.message;
      if (typeof message !== "string") {
        return errorText("message is required");
      }
      const outcome = await svc.createConversation(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          ...(typeof args.connector_id === "string" ? { connector_id: args.connector_id } : {}),
          ...(typeof args.workflow_id === "string" ? { workflow_id: args.workflow_id } : {}),
          initial_message: message,
          ...(permission_mode ? { permission_mode } : {}),
          ...(elicitationBridge ? { elicitationBridge } : {}),
        },
        db,
      );
      return successText({
        conversation_id: outcome.conversation.id,
        status: outcome.result.status,
        ...(outcome.result.pending_elicitation_id
          ? { pending_elicitation_id: outcome.result.pending_elicitation_id }
          : {}),
        ...(outcome.result.committed_workflow_id
          ? { committed_workflow_id: outcome.result.committed_workflow_id }
          : {}),
        events: outcome.result.events,
      });
    }

    if (name === "conversation_append") {
      const conversation_id = args.conversation_id;
      const message = args.message;
      if (typeof conversation_id !== "string" || typeof message !== "string") {
        return errorText("conversation_id and message are required");
      }
      // #146 / A4 + #148 — register the AbortController on the
      // synchronous frame of MCP-tool-accept so a cancel arriving in
      // the first ~40ms always finds a controller. Same pattern as
      // the HTTP messages route. Unregister in `finally`; the
      // operation here is non-streaming, so the outer guard is
      // sufficient (no SSE ownership-transfer needed).
      const turnAbortCtrl = registerConversationAbort(principal.tenant_id, conversation_id);
      try {
        const outcome = await svc.appendUserMessage(
          {
            tenant_id: principal.tenant_id,
            conversation_id,
            actor_id: principal.id,
            message,
            turn_abort_ctrl: turnAbortCtrl,
            ...(permission_mode ? { permission_mode } : {}),
            ...(elicitationBridge ? { elicitationBridge } : {}),
          },
          db,
        );
        return successText({
          conversation_id: outcome.conversation.id,
          status: outcome.result.status,
          events: outcome.result.events,
        });
      } finally {
        unregisterConversationAbort(principal.tenant_id, conversation_id, turnAbortCtrl);
      }
    }

    if (name === "conversation_respond_elicitation") {
      const conversation_id = args.conversation_id;
      const elicitation_id = args.elicitation_id;
      if (typeof conversation_id !== "string" || typeof elicitation_id !== "string") {
        return errorText("conversation_id and elicitation_id are required");
      }
      // Same sync-register pattern — see `conversation.append` above.
      const turnAbortCtrl = registerConversationAbort(principal.tenant_id, conversation_id);
      try {
        const outcome = await svc.respondElicitation(
          {
            tenant_id: principal.tenant_id,
            conversation_id,
            elicitation_id,
            actor_id: principal.id,
            output: args.output,
            turn_abort_ctrl: turnAbortCtrl,
            ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
            ...(elicitationBridge ? { elicitationBridge } : {}),
          },
          db,
        );
        return successText({
          conversation_id: outcome.conversation.id,
          status: outcome.result.status,
          events: outcome.result.events,
        });
      } finally {
        unregisterConversationAbort(principal.tenant_id, conversation_id, turnAbortCtrl);
      }
    }

    if (name === "conversation_commit") {
      const conversation_id = args.conversation_id;
      if (typeof conversation_id !== "string") {
        return errorText("conversation_id is required");
      }
      const detail = await svc.getConversation(principal.tenant_id, conversation_id, db);
      if (!detail) return errorText("conversation not found");
      if (!detail.conversation.target_workflow_id) {
        return errorText("conversation has no committed workflow");
      }
      return successText({
        conversation_id: detail.conversation.id,
        workflow_id: detail.conversation.target_workflow_id,
        status: detail.conversation.status,
      });
    }

    return errorText(`unknown conversation tool: ${name}`);
  } catch (err) {
    return errorText(toMcpErrorText(err));
  }
}

function successText(obj: unknown): HandleConversationToolResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(msg: string): HandleConversationToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
