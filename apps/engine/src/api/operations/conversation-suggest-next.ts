import { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { ConversationDetail } from "../../conversations/types.ts";
import type { Db } from "../../db/client.ts";
import { SuggestNextFeedbackBody } from "../../http/routes/conversations/schemas.ts";
import { logger } from "../../logging/index.ts";
import { recordSuggestNextOutcome } from "../../observability/index.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, plainRejection, reject } from "./index.ts";

const FeedbackResponse = z.object({ ok: z.literal(true) }).openapi("SuggestNextFeedbackResponse");

type FeedbackBody = z.infer<typeof SuggestNextFeedbackBody>;

interface FeedbackInput {
  readonly id: string;
  readonly body: FeedbackBody;
}

export interface ConversationSuggestNextServices {
  getConversation(tenant_id: string, id: string, exec: Db): Promise<ConversationDetail | null>;
  isConversationReadable(
    exec: Db,
    reader: {
      tenant_id: string;
      conversation_id: string;
      principal: ResolvedPrincipal | null | undefined;
    },
  ): Promise<boolean>;
}

function outcomeOf(body: FeedbackBody): "accepted" | "dismissed" | "typed_over" {
  if (body.source === "dismissed") return "dismissed";
  if (body.source === "typed-over") return "typed_over";
  return body.accepted ? "accepted" : "dismissed";
}

export function conversationSuggestNextOperations(svc: ConversationSuggestNextServices) {
  const feedback = defineOperation<FeedbackInput, { ok: true }>({
    id: "conversation.suggest_next.feedback",
    summary: "Record an accept / dismiss / typed-over outcome for a suggestion",
    permission: "conversation:read",
    alternatePermissions: ["workflow:read"],
    effect: "read",
    async handler(scope, { id, body }) {
      if (!scope.principal) return reject.unauthorized();
      const readable = await svc.isConversationReadable(scope.db, {
        tenant_id: scope.tenant_id,
        conversation_id: id,
        principal: scope.principal,
      });
      const conv = readable ? await svc.getConversation(scope.tenant_id, id, scope.db) : null;
      if (!conv) {
        return plainRejection(404, "conversation_not_found", "conversation not found");
      }
      recordSuggestNextOutcome({ tenant_id: scope.tenant_id, outcome: outcomeOf(body) });
      logger.info({
        module: "conversations",
        action: "suggest_next.feedback",
        msg: "next-message suggestion feedback recorded",
        tenant_id: scope.tenant_id,
        conversation_id: id,
        source: body.source,
        accepted: body.accepted,
      });
      return { ok: true as const };
    },
    http: {
      method: "post",
      path: "/v1/conversations/{id}/suggest-next/feedback",
      tags: ["conversations"],
      params: IdParam,
      body: SuggestNextFeedbackBody,
      response: FeedbackResponse,
      errors: {
        401: "Unauthenticated",
        403: "Missing conversation:read permission",
        404: "Not found",
        400: "Body failed Zod validation",
      },
      toInput: ({ param, json }) => ({
        id: (param as { id: string }).id,
        body: json as FeedbackBody,
      }),
      toBody: (result) => result,
    },
  });

  return { feedback };
}
