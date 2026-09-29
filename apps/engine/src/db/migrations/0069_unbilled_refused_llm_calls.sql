-- A call that failed without producing output was never processed by the
-- provider: a refusal (quota, rate limit, auth, context too large) or SubKit's
-- own budget cap turning it away. Those rows used to carry the tokenizer's
-- ESTIMATE of the prompt, and every spend reader — cost, conversation usage,
-- the monthly budget — summed it as tokens spent. The row stays as the record
-- of the failed call; only its billed token counts go to zero, the same rule
-- `billedTokenUsage` applies to every row written from now on.
UPDATE "llm_usage"
SET "prompt_tokens" = 0,
    "cache_read_tokens" = 0,
    "cache_creation_tokens" = 0,
    "total_tokens" = 0
WHERE "result" <> 'success'
  AND "completion_tokens" = 0
  AND ("prompt_tokens" <> 0 OR "cache_read_tokens" <> 0 OR "cache_creation_tokens" <> 0 OR "total_tokens" <> 0);
