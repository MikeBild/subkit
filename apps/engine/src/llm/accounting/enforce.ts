export class LlmBudgetExceededError extends Error {
  readonly code = "llm_budget_exceeded";
  readonly running_total: number;
  readonly estimated_call_tokens: number;
  readonly cap: number;

  constructor(params: { running_total: number; estimated_call_tokens: number; cap: number }) {
    super(
      `per-run LLM token cap exceeded: running ${params.running_total} + estimated ${params.estimated_call_tokens} > cap ${params.cap}`,
    );
    this.name = "LlmBudgetExceededError";
    this.running_total = params.running_total;
    this.estimated_call_tokens = params.estimated_call_tokens;
    this.cap = params.cap;
  }
}

export interface LlmCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export class RunLlmBudget {
  private running = 0;
  constructor(readonly cap: number | null) {}

  get total(): number {
    return this.running;
  }

  checkPreCall(estimated_call_tokens: number): void {
    if (this.cap == null) return;
    if (this.running + estimated_call_tokens > this.cap) {
      throw new LlmBudgetExceededError({
        running_total: this.running,
        estimated_call_tokens,
        cap: this.cap,
      });
    }
  }

  account(usage: LlmCallUsage): void {
    this.running += Math.max(0, usage.total_tokens);
  }
}
