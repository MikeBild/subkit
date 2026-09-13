// One surface for LLM token + budget accounting. Consolidates four
// files that previously lived under three different subsystems:
//
//   count.ts       — pre-call token counting (was llm/tokens.ts)
//   budget.ts      — per-tenant monthly budget + ledger
//                    (was llm/budgets.ts)
//   accountant.ts  — post-hoc reconciliation of SDK-reported usage
//                    (was llm/core/token-accountant.ts)
//   enforce.ts     — per-run token cap on workflow request steps
//                    (was execution/llm-budget.ts)
//
// Two byte-budget files are intentionally NOT consolidated here:
// knowledge/budgets.ts and docs-ingestion/budgets.ts gate file-storage
// and HTTP-fetch resource usage, not LLM tokens. They share the word
// "budget" but not the logic.

export { account, type AccountParams, type AccountResult } from "./accountant.ts";
export { type ActorFields, actorFields } from "./actor.ts";
export {
  checkAndDecrement,
  type CheckAndDecrementResult,
  checkBudget,
  currentMonthBucket,
  monthlyUsage,
  monthlyUsageForUser,
  recordUsage,
  resolveMonthlyBudget,
  resolveUserMonthlyBudget,
} from "./budget.ts";
export {
  completionBudgetFor,
  contextCapFor,
  countMessagesTokens,
  countModelMessagesTokens,
  countTokens,
  estimatePromptTokens,
} from "./count.ts";
export {
  estimateLlmCallTokens,
  isLlmProviderUrl,
  LlmBudgetExceededError,
  type LlmCallUsage,
  parseLlmUsage,
  RunLlmBudget,
  stepLooksLikeLlmCall,
} from "./enforce.ts";
