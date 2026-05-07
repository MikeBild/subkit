// Conversations: persistent resumable AI authoring sessions streamed
// over SSE (REST) and MCP progress notifications. Structured-intent
// tool loop landed in P10.

// `mergeAbortSignals` is deliberately NOT re-exported. Sole consumer
// is `./loop.ts`, which imports it directly from `./abort.ts`. Widening
// the public surface invites cross-package use that hides ownership of
// the merged controller's lifetime. (#147 review S-1: keeping this
// rationale inline so an "organize imports" tool doesn't strand it.)
export {
  CONVERSATION_CANCELLED_REASON,
  cancelConversationAbort,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";
export * from "./attachments.ts";
export * from "./parts.ts";
export * from "./service.ts";
export * from "./streaming.ts";
export * from "./tool-policies.ts";
export * from "./types.ts";
