// One surface for LLM token + budget accounting — Phase 3 of the
// 2026-05 architecture audit (issue #89). Consolidates four files
// that previously lived under three different subsystems:
//
//   count.ts       — pre-call token counting (was llm/tokens.ts)
//   budget.ts      — per-tenant monthly budget + ledger
//                    (was llm/budgets.ts)
//   accountant.ts  — post-hoc reconciliation of SDK-reported usage
//                    (was llm/core/token-accountant.ts)
//   enforce.ts     — per-run token cap on workflow request steps
//                    (was execution/llm-budget.ts)
//
// Two byte-budget files were intentionally LEFT IN PLACE despite the
// audit doc's original framing: knowledge/budgets.ts and
// docs-ingestion/budgets.ts gate file-storage and HTTP-fetch resource
// usage, not LLM tokens. They share the word "budget" but not the
// logic. The audit doc §4.3 is updated alongside this consolidation
// so the scope reflects reality.

export {
  type AccountParams,
  type AccountResult,
  account,
} from "./accountant.ts";
export {
  type CheckAndDecrementResult,
  checkAndDecrement,
  checkBudget,
  currentMonthBucket,
  monthlyUsage,
  recordUsage,
  resolveMonthlyBudget,
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
