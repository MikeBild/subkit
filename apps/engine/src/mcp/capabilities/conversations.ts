// MCP conversation tool cluster.
//
// Exposes five tools that drive a full authoring session over the
// MCP transport:
//
//   - conversation.start(connector_id?, workflow_id?, message)
//   - conversation.append(conversation_id, message)
//   - conversation.approve(conversation_id, approval_id)
//   - conversation.reject(conversation_id, approval_id, reason?)
//   - conversation.commit(conversation_id)
//
// These are additive to the P7 `wf.<slug>` workflow tools — the list
// handler in `capabilities/tools.ts` concatenates both sets before
// responding to `tools/list`.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as svc from "../../conversations/service.ts";
import type { Db } from "../../db/client.ts";

export const CONVERSATION_TOOL_PREFIX = "conversation.";

export function listConversationTools(): Tool[] {
  return [
    {
      name: "conversation.start",
      description: "Start a new authoring conversation and drive the first turn.",
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
      name: "conversation.append",
      description: "Append a user message to an existing conversation and drive another turn.",
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
      name: "conversation.approve",
      description: "Approve a pending approval request and resume the loop.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string" },
          approval_id: { type: "string" },
        },
        required: ["conversation_id", "approval_id"],
      },
    },
    {
      name: "conversation.reject",
      description: "Reject a pending approval request.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string" },
          approval_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["conversation_id", "approval_id"],
      },
    },
    {
      name: "conversation.commit",
      description: "Return the committed workflow id for a committed conversation.",
      inputSchema: {
        type: "object",
        properties: { conversation_id: { type: "string" } },
        required: ["conversation_id"],
      },
    },
  ];
}

export interface HandleConversationToolParams {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  args: Record<string, unknown>;
}

export interface HandleConversationToolResult {
  isError: boolean;
  content: Array<{ type: "text" } & { text: string }>;
}

export async function handleConversationTool(
  p: HandleConversationToolParams,
): Promise<HandleConversationToolResult> {
  const { db, principal, name, args } = p;
  try {
    if (name === "conversation.start") {
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
        },
        db,
      );
      return successText({
        conversation_id: outcome.conversation.id,
        status: outcome.result.status,
        ...(outcome.result.pending_approval_id
          ? { pending_approval_id: outcome.result.pending_approval_id }
          : {}),
        ...(outcome.result.committed_workflow_id
          ? { committed_workflow_id: outcome.result.committed_workflow_id }
          : {}),
        events: outcome.result.events,
      });
    }

    if (name === "conversation.append") {
      const conversation_id = args.conversation_id;
      const message = args.message;
      if (typeof conversation_id !== "string" || typeof message !== "string") {
        return errorText("conversation_id and message are required");
      }
      const outcome = await svc.appendUserMessage(
        {
          tenant_id: principal.tenant_id,
          conversation_id,
          actor_id: principal.id,
          message,
        },
        db,
      );
      return successText({
        conversation_id: outcome.conversation.id,
        status: outcome.result.status,
        events: outcome.result.events,
      });
    }

    if (name === "conversation.approve" || name === "conversation.reject") {
      const conversation_id = args.conversation_id;
      const approval_id = args.approval_id;
      if (typeof conversation_id !== "string" || typeof approval_id !== "string") {
        return errorText("conversation_id and approval_id are required");
      }
      const outcome = await svc.decideApproval(
        {
          tenant_id: principal.tenant_id,
          conversation_id,
          approval_id,
          actor_id: principal.id,
          decision: name === "conversation.approve" ? "approved" : "rejected",
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        },
        db,
      );
      return successText({
        conversation_id: outcome.conversation.id,
        status: outcome.result.status,
        ...(outcome.result.committed_workflow_id
          ? { committed_workflow_id: outcome.result.committed_workflow_id }
          : {}),
        events: outcome.result.events,
      });
    }

    if (name === "conversation.commit") {
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
    const msg = err instanceof Error ? err.message : String(err);
    return errorText(msg);
  }
}

function successText(obj: unknown): HandleConversationToolResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(msg: string): HandleConversationToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
