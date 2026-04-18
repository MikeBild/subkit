// Tool result truncation for LLM context.
//
// Long tool outputs (e.g. list_executions with 50 rows of complex
// payloads) blow the prompt budget on subsequent turns. We truncate the
// structured output before feeding it back to the model, and stash the
// raw payload under an in-memory ref so a follow-up `get_raw_result`
// tool call can retrieve it on demand.

const MAX_JSON_CHARS = 8000;
const MAX_ARRAY_LEN = 20;

const rawStore = new Map<string, unknown>();

export interface TruncatedOutput {
  truncated: boolean;
  data: unknown;
  raw_ref?: string;
  note?: string;
}

function truncateArray(arr: unknown[]): { arr: unknown[]; dropped: number } {
  if (arr.length <= MAX_ARRAY_LEN) return { arr, dropped: 0 };
  return { arr: arr.slice(0, MAX_ARRAY_LEN), dropped: arr.length - MAX_ARRAY_LEN };
}

function approxJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateNode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const { arr, dropped } = truncateArray(value);
    const mapped = arr.map(truncateNode);
    if (dropped > 0) mapped.push({ __truncated: `+${dropped} more items` });
    return mapped;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateNode(v);
  }
  return out;
}

/**
 * Truncate a tool's output to fit LLM context. Stores the full payload
 * under an in-memory ref; callers surface `raw_ref` in the tool result
 * so the model can fetch the untruncated form via `get_raw_result`.
 */
export function truncateForLlm(output: unknown): TruncatedOutput {
  const originalLen = approxJsonLength(output);
  if (originalLen <= MAX_JSON_CHARS) {
    return { truncated: false, data: output };
  }
  const shortened = truncateNode(output);
  const shortenedLen = approxJsonLength(shortened);
  const refId = `raw_${crypto.randomUUID().slice(0, 8)}`;
  rawStore.set(refId, output);
  // Evict older entries beyond a soft cap to prevent unbounded growth.
  if (rawStore.size > 256) {
    const firstKey = rawStore.keys().next().value;
    if (firstKey !== undefined) rawStore.delete(firstKey);
  }
  return {
    truncated: true,
    data: shortened,
    raw_ref: refId,
    note: `tool output truncated from ${originalLen} → ${shortenedLen} chars; call get_raw_result(ref="${refId}") for the full payload`,
  };
}

export function getRawResult(ref: string): unknown | undefined {
  return rawStore.get(ref);
}

export function clearRawStore(): void {
  rawStore.clear();
}
