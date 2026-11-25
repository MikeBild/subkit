import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  conversationViewerOf,
  loadConversationAccess,
  moveConversationVisibility,
  storeConversationVisibility,
  type VisibilityAction,
} from "../../conversations/public/lifecycle.ts";
import type { ConversationRecord } from "../../conversations/types.ts";
import { ConversationSchema } from "../../http/routes/conversations/schemas.ts";
import { IdParam } from "../common-schemas.ts";
import { requireBrowserSession } from "./browser-session.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";

const ConfirmBody = z
  .object({
    confirm: z
      .literal(true)
      .describe("The owner's explicit yes to changing who can read this conversation."),
  })
  .strict()
  .openapi("ConversationVisibilityConfirmBody");

interface IdInput {
  readonly id: string;
}

const COPY: Record<
  VisibilityAction,
  {
    readonly id: string;
    readonly summary: string;
    readonly description: string;
    readonly audit:
      | typeof AuditAction.CONVERSATION_SHARED
      | typeof AuditAction.CONVERSATION_UNSHARED;
    readonly session: string;
  }
> = {
  share: {
    id: "conversation.share",
    summary: "Share one of your own conversations with the team",
    description:
      "Lets everyone in the workspace with conversation:read read the conversation; only the owner keeps writing in it, others can fork it. The conversation is not copied, only its visibility changes. Needs the owner's explicit confirmation in a Cockpit browser session.",
    audit: AuditAction.CONVERSATION_SHARED,
    session: "Only the owner, signed in to the Cockpit, shares a conversation.",
  },
  unshare: {
    id: "conversation.unshare",
    summary: "Make a shared conversation private again",
    description:
      "Only the owner can read the conversation again. Forks others made earlier stay theirs. Needs the owner's explicit confirmation in a Cockpit browser session.",
    audit: AuditAction.CONVERSATION_UNSHARED,
    session: "Only the owner, signed in to the Cockpit, makes a conversation private.",
  },
};

const REFUSALS = {
  not_found: () => reject.notFound("conversation"),
  not_owner: () =>
    reject.status(403, "not_conversation_owner", "Only the owner changes who can read this."),
  task_run: () =>
    reject.conflict(
      "A task-run conversation keeps its own access rule and cannot be shared.",
      undefined,
      "task_run_conversation",
    ),
  already_shared: () =>
    reject.conflict(
      "The conversation is already shared with the team.",
      undefined,
      "already_shared",
    ),
  already_private: () =>
    reject.conflict("The conversation is already private.", undefined, "already_private"),
} as const satisfies Record<string, () => Rejection>;

function visibilityOperation(action: VisibilityAction) {
  const copy = COPY[action];
  return defineOperation<IdInput, ConversationRecord>({
    id: copy.id,
    summary: copy.summary,
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: copy.audit,
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const facts = await loadConversationAccess(scope.db, scope.tenant_id, id);
      if (!facts) return REFUSALS.not_found();
      const move = moveConversationVisibility(conversationViewerOf(principal), facts.row, action);
      if (move.kind === "rejected") return REFUSALS[move.reason]();
      const signedIn = requireBrowserSession(principal, copy.session);
      if (isRejection(signedIn)) return signedIn;
      const stored = await storeConversationVisibility(scope.db, {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        from: facts.row.visibility,
        to: move.visibility,
      });
      if (!stored) return REFUSALS[action === "share" ? "already_shared" : "already_private"]();
      await auditAwait(
        {
          tenant_id: scope.tenant_id,
          actor_type: "user",
          actor_id: principal.id,
          action: copy.audit,
          resource_type: "conversation",
          resource_id: id,
          result: "success",
          metadata: { from: facts.row.visibility, to: move.visibility },
        },
        scope.db,
      );
      return stored;
    },
    http: {
      method: "post",
      path: `/v1/conversations/{id}/${action}`,
      tags: ["conversations"],
      description: copy.description,
      params: IdParam,
      body: ConfirmBody,
      response: ConversationSchema,
      errors: {
        403: "human_confirmation_required — only the owner in a Cockpit browser session; not_conversation_owner",
        404: "Not found",
        409:
          action === "share"
            ? "already_shared; task_run_conversation"
            : "already_private; task_run_conversation",
      },
      toInput: ({ param }) => ({ id: (param as IdInput).id }),
      toBody: (result) => result,
    },
  });
}

export const shareConversationOperation = visibilityOperation("share");
export const unshareConversationOperation = visibilityOperation("unshare");
