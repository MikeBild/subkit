// Conversations: persistent resumable AI authoring sessions streamed
// over SSE (REST) and MCP progress notifications. Structured-intent
// tool loop landed in P10.

export {
  CONVERSATION_CANCELLED_REASON,
  cancelConversationAbort,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";
// `mergeAbortSignals` is intentionally not re-exported here — its
// only consumer (`./loop.ts`) imports it directly from `./abort.ts`,
// and widening the public surface invites cross-package use that
// hides ownership of the merged controller's lifetime.
export * from "./attachments.ts";
export * from "./parts.ts";
export * from "./service.ts";
export * from "./streaming.ts";
export * from "./tool-policies.ts";
export * from "./types.ts";
