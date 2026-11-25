import type { OpenAPIHono } from "@hono/zod-openapi";
import { conversationSuggestNextOperations } from "../../../api/operations/conversation-suggest-next.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  getConversation,
  isConversationReadable,
} from "../../../conversations/public/lifecycle.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerSuggestNextFeedbackRoute(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(
    app,
    conversationSuggestNextOperations({ getConversation, isConversationReadable }).feedback,
  );
}
