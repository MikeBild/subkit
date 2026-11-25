import { z } from "@hono/zod-openapi";
import { actorType } from "../../audit/actor.ts";
import type { AuditActorType } from "../../audit/types.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { isConversationReadable } from "../../conversations/public/lifecycle.ts";
import type { ConversationRecord } from "../../conversations/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationLocale } from "../../http/routes/conversations/locale.ts";
import {
  CompactConversationBody,
  CompactConversationResponse,
  ContextSnapshotSchema,
  ConversationSchema,
} from "../../http/routes/conversations/schemas.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const ForkFromMessageParam = z.object({
  id: z.string().uuid(),
  message_id: z.string().uuid(),
});

const ForkFromMessageResponse = z
  .object({
    conversation: ConversationSchema,
    source_conversation_id: z.string().uuid(),
    anchor_message_id: z.string().uuid(),
    copied_message_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .openapi("ForkFromMessageResponse");

const DeleteConversationResponse = z
  .object({
    id: z.string().uuid(),
    deleted: z.literal(true),
  })
  .openapi("DeleteConversationResponse");

const WRITE_PERMISSIONS = {
  permission: "conversation:write",
  alternatePermissions: ["workflow:write"],
};
const READ_PERMISSIONS = {
  permission: "conversation:read",
  alternatePermissions: ["workflow:read"],
};

interface IdInput {
  readonly id: string;
}

interface CompactInput extends IdInput {
  readonly keep_last?: number;
}

interface ForkInput extends IdInput {
  readonly message_id: string;
}

type DeleteOutcome =
  | { kind: "deleted"; id: string }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "turn_running" };

export interface ConversationLifecycleServices {
  readonly FORK_COPY_MESSAGE_CAP: number;
  cancelConversation(
    tenant_id: string,
    conversation_id: string,
    actor_id: string | null,
    exec: Db,
    actor_type?: "user" | "system_account" | "system" | "unknown",
    principal?: ResolvedPrincipal | null,
  ): Promise<ConversationRecord | null>;
  interruptTaskRunTurn(
    tenant_id: string,
    conversation_id: string,
    actor_id: string | null,
    exec: Db,
    actor_type?: "user" | "system_account" | "system" | "unknown",
    principal?: ResolvedPrincipal | null,
  ): Promise<ConversationRecord | null>;
  deleteConversation(
    p: {
      tenant_id: string;
      conversation_id: string;
      actor_id: string;
      actor_type: "user" | "system_account" | "system";
      actor_is_admin: boolean;
      request_source: "api";
    },
    exec: Db,
  ): Promise<DeleteOutcome>;
  setConversationHidden(
    p: {
      tenant_id: string;
      conversation_id: string;
      user_id: string;
      hidden: boolean;
      principal?: ResolvedPrincipal | null;
    },
    exec: Db,
  ): Promise<ConversationRecord | null>;
  getContextSnapshot(
    tenant_id: string,
    conversation_id: string,
    exec: Db,
    principal: ResolvedPrincipal,
    locale: "de" | "en",
  ): Promise<object | null>;
  registerConversationAbort(
    tenant_id: string,
    conversation_id: string,
    db: Db,
  ): Promise<AbortController>;
  unregisterConversationAbort(
    tenant_id: string,
    conversation_id: string,
    ctrl: AbortController,
  ): Promise<void>;
  compactConversation(
    p: {
      tenant_id: string;
      conversation_id: string;
      actor_id: string | null;
      actor_type: AuditActorType;
      principal?: ResolvedPrincipal | null;
      keep_last?: number;
    },
    exec: Db,
  ): Promise<object>;
  assertConversationWriter(
    exec: Db,
    writer: {
      tenant_id: string;
      conversation_id: string;
      actor_id: string | null;
      principal?: ResolvedPrincipal | null;
    },
  ): Promise<unknown>;
  forkConversation(
    p: {
      tenant_id: string;
      source_conversation_id: string;
      anchor_message_id: string;
      actor_id: string | null;
      actor_type: AuditActorType;
      request_source: "api";
    },
    exec: Db,
  ): Promise<object | null>;
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

function same<T>(result: T): T {
  return result;
}

export function conversationLifecycleOperations(svc: ConversationLifecycleServices) {
  const cancel = defineOperation<IdInput, ConversationRecord>({
    id: "conversation.cancel",
    summary: "Cancel a conversation",
    permission: "conversation:cancel",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.CONVERSATION_CANCELLED,
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const args = [
        scope.tenant_id,
        id,
        principal.id,
        scope.db,
        actorType(principal),
        principal,
      ] as const;
      const row =
        (await svc.interruptTaskRunTurn(...args)) ?? (await svc.cancelConversation(...args));
      return row ?? reject.notFound("conversation");
    },
    http: {
      method: "post",
      path: "/v1/conversations/{id}/cancel",
      tags: ["conversations"],
      params: IdParam,
      response: ConversationSchema,
      errors: { 404: "Not found" },
      toInput: ({ param }) => idFrom(param),
      toBody: same,
    },
  });

  const remove = defineOperation<IdInput, { id: string }>({
    id: "conversation.delete",
    summary: "Delete a conversation for everyone",
    ...WRITE_PERMISSIONS,
    effect: "write",
    audit: AuditAction.CONVERSATION_DELETED,
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const result = await svc.deleteConversation(
        {
          tenant_id: scope.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          actor_type: actorType(principal),
          actor_is_admin: hasBuiltinAdminRole(principal),
          request_source: "api",
        },
        scope.db,
      );
      if (result.kind === "not_found") return reject.notFound("conversation");
      if (result.kind === "forbidden") return reject.forbidden("not_conversation_owner");
      if (result.kind === "turn_running") {
        return reject.conflict("A turn is still running in this conversation; stop it first.", {
          reason: "turn_running",
        });
      }
      return { id: result.id };
    },
    http: {
      method: "delete",
      path: "/v1/conversations/{id}",
      tags: ["conversations"],
      description:
        "Removes the conversation with its messages, tool calls and file links; the " +
        "files themselves stay. Only the owner or an administrator may delete. Refused " +
        "with 409 while a turn is running. Hiding (`/hide`) only takes it out of the " +
        "caller's own list.",
      params: IdParam,
      response: DeleteConversationResponse,
      success: { status: 200, description: "Deleted" },
      errors: {
        403: "Forbidden — neither the owner nor an administrator",
        404: "Not found",
        409: "A turn is still running",
      },
      toInput: ({ param }) => idFrom(param),
      toBody: (result) => ({ id: result.id, deleted: true as const }),
    },
  });

  function visibilityOperation(hidden: boolean) {
    return defineOperation<IdInput, ConversationRecord>({
      id: hidden ? "conversation.hide" : "conversation.unhide",
      summary: hidden
        ? "Hide a conversation from the caller's own list (reversible, never a delete)"
        : "Put a hidden conversation back into the caller's list",
      permission: null,
      effect: "write",
      audit: hidden ? AuditAction.CONVERSATION_HIDDEN : AuditAction.CONVERSATION_UNHIDDEN,
      async handler(scope, { id }) {
        const principal = scope.principal;
        if (!principal) return reject.unauthorized();
        if (principal.kind !== "user") {
          return reject.forbidden("conversation_list_visibility_requires_user");
        }
        const row = await svc.setConversationHidden(
          {
            tenant_id: scope.tenant_id,
            conversation_id: id,
            user_id: principal.id,
            hidden,
            principal,
          },
          scope.db,
        );
        return row ?? reject.notFound("conversation");
      },
      http: {
        method: "post",
        path: hidden ? "/v1/conversations/{id}/hide" : "/v1/conversations/{id}/unhide",
        tags: ["conversations"],
        params: IdParam,
        response: ConversationSchema,
        errors: {
          403: hidden
            ? "Forbidden — hiding is available for user-owned conversation lists"
            : "Forbidden — visibility is available for user-owned conversation lists",
          404: "Not found",
        },
        toInput: ({ param }) => idFrom(param),
        toBody: same,
      },
    });
  }

  const contextSnapshot = defineOperation<IdInput, object>({
    id: "conversation.context_snapshot",
    summary: "Summary of the context currently in scope for a conversation",
    ...READ_PERMISSIONS,
    effect: "read",
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const headers = scope.request?.headers;
      const snapshot = await svc.getContextSnapshot(
        scope.tenant_id,
        id,
        scope.db,
        principal,
        conversationLocale(
          headers?.get("cookie") ?? undefined,
          headers?.get("accept-language") ?? undefined,
        ),
      );
      return snapshot ?? reject.notFound("conversation");
    },
    http: {
      method: "get",
      path: "/v1/conversations/{id}/context-snapshot",
      tags: ["conversations"],
      params: IdParam,
      response: ContextSnapshotSchema,
      errors: { 404: "Not found" },
      toInput: ({ param }) => idFrom(param),
      toBody: same,
    },
  });

  const compact = defineOperation<CompactInput, object>({
    id: "conversation.compact",
    summary: "Compact a conversation's message history into a summary",
    ...WRITE_PERMISSIONS,
    effect: "write",
    audit: AuditAction.CONVERSATION_COMPACTED,
    async handler(scope, { id, keep_last }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      await svc.assertConversationWriter(scope.db, {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        actor_id: principal.id,
        principal,
      });
      const ctrl = await svc.registerConversationAbort(scope.tenant_id, id, scope.db);
      try {
        return await svc.compactConversation(
          {
            tenant_id: scope.tenant_id,
            conversation_id: id,
            actor_id: principal.id,
            actor_type: actorType(principal),
            principal,
            ...(keep_last !== undefined ? { keep_last } : {}),
          },
          scope.db,
        );
      } finally {
        await svc.unregisterConversationAbort(scope.tenant_id, id, ctrl);
      }
    },
    http: {
      method: "post",
      path: "/v1/conversations/{id}/compact",
      tags: ["conversations"],
      params: IdParam,
      body: CompactConversationBody,
      response: CompactConversationResponse,
      errors: { 404: "Not found", 409: "Conversation turn already running" },
      toInput: ({ param, json }) => {
        const { keep_last } = json as z.infer<typeof CompactConversationBody>;
        return { ...idFrom(param), ...(keep_last !== undefined ? { keep_last } : {}) };
      },
      toBody: same,
    },
  });

  const fork = defineOperation<ForkInput, object>({
    id: "conversation.fork_from_message",
    summary: "Fork a conversation, copying messages up to and including the anchor",
    ...WRITE_PERMISSIONS,
    effect: "write",
    audit: AuditAction.CONVERSATION_FORKED,
    async handler(scope, { id, message_id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const readable = await isConversationReadable(scope.db, {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        principal,
      });
      if (!readable) return reject.notFound("conversation");
      const result = await svc.forkConversation(
        {
          tenant_id: scope.tenant_id,
          source_conversation_id: id,
          anchor_message_id: message_id,
          actor_id: principal.id,
          actor_type: actorType(principal),
          request_source: "api",
        },
        scope.db,
      );
      return result ?? reject.notFound("conversation");
    },
    http: {
      method: "post",
      path: "/v1/conversations/{id}/fork-from-message/{message_id}",
      tags: ["conversations"],
      description:
        "Creates a new conversation owned by the same tenant + actor and copies " +
        "messages [0..anchor] in created_at order. Tool calls and elicitations are " +
        "NOT copied — re-running them would duplicate side effects. Caveat: " +
        "assistant message content that references `tool_call_id` values from the " +
        "source will retain those refs even though the corresponding tool_call " +
        "rows are not in the fork; the CLI renderer treats unknown ids as plain " +
        "text, but audit-log readers should be aware. Each copied message gets a " +
        "fresh `created_at` (set to fork-time) so the fork's timeline orders " +
        "cleanly; the source's original timestamps are preserved in the source " +
        "conversation, joinable via `forked_from` in the audit metadata. The " +
        `fork is hard-capped at the most recent ${svc.FORK_COPY_MESSAGE_CAP.toLocaleString("en-US")} messages up to and ` +
        "including the anchor; when the cap fires the response sets " +
        "`truncated: true` and the audit row records the original source count.",
      params: ForkFromMessageParam,
      response: ForkFromMessageResponse,
      errors: {
        401: "Unauthenticated",
        403: "Forbidden — principal lacks conversation:write or workflow:write",
        404: "Not found",
      },
      toInput: ({ param }) => param as ForkInput,
      toBody: same,
    },
  });
  return {
    cancel,
    remove,
    hide: visibilityOperation(true),
    unhide: visibilityOperation(false),
    contextSnapshot,
    compact,
    fork,
  };
}
