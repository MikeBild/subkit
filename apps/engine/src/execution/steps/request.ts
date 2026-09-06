// Barrel for the HTTP request step driver. The implementation lives
// under `request/`:
//   - `request/errors.ts`   — typed RequestError
//   - `request/retry.ts`    — backoff / 429 / idempotency policy
//   - `request/shape.ts`    — schema-required + LLM-model + auth helpers
//   - `request/dispatch.ts` — fetchOnce + doOnePage + runRequestStep
//
// External callers continue to import from `./steps/request.ts`.

export {
  REQUEST_TIMEOUT_DEFAULT_MS,
  type RunRequestStepParams,
  runRequestStep,
} from "./request/dispatch.ts";
export { RequestError } from "./request/errors.ts";
export {
  REQUEST_MAX_RETRIES_DEFAULT,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type RetryPolicy,
  requestMaxAttempts,
  resolveRetryPolicy,
} from "./request/retry.ts";
