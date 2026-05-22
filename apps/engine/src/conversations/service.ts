// Conversations service — public API used by REST + MCP.
//
// Thin barrel. After the Phase 4 split (audit §4.1) the implementation
// lives in `service/`:
//
//   - `service/shared.ts`    — Executor type + permission-mode helpers
//                               + rowToRecord + isAskUserToolName +
//                               shared error / outcome types
//   - `service/get.ts`       — getConversation (the read path that
//                               every other op delegates to)
//   - `service/create.ts`    — createConversation + CreateConversationParams
//   - `service/append.ts`    — appendUserMessage + AppendMessageParams
//   - `service/elicit.ts`    — respondElicitation + RespondElicitationParams
//                               + auto-persist + commit short-circuit
//   - `service/snapshot.ts`  — getContextSnapshot + ContextSnapshot
//   - `service/lifecycle.ts` — cancelConversation + listConversations +
//                               patchConversation + the list/patch types
//   - `service/compact.ts`   — compactConversation + CompactConversationResult
//                               + undoLastDraftMutation
//
// External callers (REST routes use `import * as svc from "../../conversations/service.ts"`)
// continue to see the same public surface.

export {
  type AppendMessageParams,
  type AppendMessageResult,
  appendUserMessage,
} from "./service/append.ts";
export {
  type CompactConversationParams,
  type CompactConversationResult,
  compactConversation,
  undoLastDraftMutation,
} from "./service/compact.ts";
export {
  type CreateConversationParams,
  type CreateConversationResult,
  createConversation,
} from "./service/create.ts";
export {
  type RespondElicitationParams,
  respondElicitation,
} from "./service/elicit.ts";
export {
  FORK_COPY_MESSAGE_CAP,
  type ForkConversationParams,
  type ForkConversationResult,
  forkConversation,
} from "./service/fork.ts";
export { getConversation } from "./service/get.ts";
export {
  type ConversationListItem,
  cancelConversation,
  type ListConversationsParams,
  listConversations,
  type PatchConversationParams,
  patchConversation,
} from "./service/lifecycle.ts";
export {
  type RunConversationTurnParams,
  runConversationTurn,
} from "./service/run-turn.ts";
export {
  type ConversationTurnOutcome,
  ElicitationAlreadyResolvedError,
  PendingElicitationBlockedError,
  type PendingElicitationSummary,
} from "./service/shared.ts";
export {
  type ContextSnapshot,
  getContextSnapshot,
} from "./service/snapshot.ts";
