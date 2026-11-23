const PRELOAD_MIN_WORDS = 3;
const PRELOAD_HITS = 3;
const PRELOAD_CAP_SHARE = 0.03;
const PRELOAD_QUERY_CHARS = 512;

export interface KnowledgePreloadPlan {
  query: string;
  limit: number;
  token_budget: number;
}

export function knowledgePreloadPlan(input: {
  flow: string;
  latest_user_text: string | null | undefined;
  cap_tokens: number;
}): KnowledgePreloadPlan | null {
  if (input.flow !== "converse") return null;
  const query = (input.latest_user_text ?? "").replace(/\s+/g, " ").trim();
  const words = query.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length < PRELOAD_MIN_WORDS) return null;
  const token_budget = Math.floor(input.cap_tokens * PRELOAD_CAP_SHARE);
  if (token_budget <= 0) return null;
  return { query: query.slice(0, PRELOAD_QUERY_CHARS), limit: PRELOAD_HITS, token_budget };
}

export function withinTokenBudget<T extends { tokens: number }>(
  items: readonly T[],
  token_budget: number,
): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.tokens > token_budget) break;
    kept.push(item);
    used += item.tokens;
  }
  return kept;
}
