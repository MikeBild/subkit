import { z } from "@hono/zod-openapi";
import { PlaybookConflictError, readPlaybook, updatePlaybook } from "../playbook.ts";
import { PlaybookUpdateSchema } from "../playbook-contract.ts";
import {
  listRecentSuccessfulToolCalls,
  readConversationPlaybookMode,
} from "../service/tool-state.ts";
import type { ConversationTool } from "./index.ts";

export const inspectPlaybookTool: ConversationTool = {
  name: "inspect_playbook",
  description:
    "Read the current playbook, revision, evidence status and identifiers of recent successful read tools. A null playbook starts at revision zero. No action is executed.",
  inputSchema: z.object({}),
  category: "tenant_read",
  visible_when_readonly: true,
  permission: {
    action: "conversation:read",
    resourceType: "conversation",
    resolveResourceId: async (ctx) => ctx.conversation_id,
  },
  async execute(ctx) {
    if (!ctx.principal) return { ok: false, error_code: "principal_required" };
    const mode = await readConversationPlaybookMode(ctx.db, {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    });
    if (mode === "off") return { ok: false, error_code: "playbooks_disabled" };
    const scope = {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      principal: ctx.principal,
      ...(ctx.locale ? { locale: ctx.locale } : {}),
    };
    const playbook = await readPlaybook(ctx.db, scope);
    const calls = await listRecentSuccessfulToolCalls(ctx.db, scope, 30);
    return {
      ok: true,
      data: {
        playbook,
        revision: playbook?.revision ?? 0,
        recent_evidence: calls.filter((call) =>
          [
            "get_connector",
            "get_workflow",
            "get_execution",
            "inspect_execution",
            "read_knowledge",
            "preview_attachment",
            "get_intake_item",
          ].includes(call.tool),
        ),
      },
    };
  },
};
export const updatePlaybookTool: ConversationTool = {
  name: "update_playbook",
  description:
    "Create or replace the conversation's logical playbook using expected_revision. This only stores guidance and evidence references; it does not execute workflows or approve effects. Empty evidence_ids bind the latest applicable stored evidence automatically. Assessment is never a technical verification. If the deliverable is an assessment or a resource read, set completion_step_id to null; only point it to human_confirmation or execution_succeeded proof. Example: a delivered report with no execution or decision requirement uses null. Do not request human confirmation just to complete a sidebar.",
  inputSchema: PlaybookUpdateSchema,
  strict: false,
  category: "draft_write",
  captures_draft_snapshot: false,
  visible_when_readonly: true,
  permission: {
    action: "conversation:write",
    resourceType: "conversation",
    resolveResourceId: async (ctx) => ctx.conversation_id,
  },
  async execute(ctx, args) {
    if (!ctx.principal) return { ok: false, error_code: "principal_required" };
    try {
      const playbook = await updatePlaybook(
        ctx.db,
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          principal: ctx.principal,
          ...(ctx.locale ? { locale: ctx.locale } : {}),
        },
        args,
      );
      return { ok: true, data: { playbook } };
    } catch (error) {
      return {
        ok: false,
        error_code:
          error instanceof PlaybookConflictError ? error.code : "playbook_update_rejected",
        message: error instanceof Error ? error.message : "Playbook update rejected",
        ...(error instanceof PlaybookConflictError
          ? { details: { current_revision: error.current_revision } }
          : {}),
      };
    }
  },
};
