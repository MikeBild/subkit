import type { OpenAPIHono } from "@hono/zod-openapi";
import { chatComposerOperations } from "../../api/operations/chat-composer.ts";
import { conversationAttachmentOperations } from "../../api/operations/conversation-attachments.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import type { AppEnv } from "../openapi.ts";

export function registerConversationAttachmentRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, conversationAttachmentOperations.upload);
  toHonoRoute(app, conversationAttachmentOperations.list);
  toHonoRoute(app, conversationAttachmentOperations.remove);
  toHonoRoute(app, chatComposerOperations.list);
  toHonoRoute(app, chatComposerOperations.stage);
  toHonoRoute(app, chatComposerOperations.claim);
  toHonoRoute(app, chatComposerOperations.remove);
}
