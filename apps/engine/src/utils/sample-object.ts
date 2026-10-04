import { LLM_TOOL_RESULT_ARRAY_CAP, LLM_TOOL_RESULT_SAMPLE_DEPTH } from "../execution/timeouts.ts";

export const SAMPLE_MARKER_TRUNCATED_COUNT = "_truncated_count";
export const SAMPLE_MARKER_TRUNCATED_KIND = "_truncated_kind";
export const SAMPLE_MARKER_TRUNCATED_KEYS = "_truncated_keys";

export interface SampleOptions {
  depth?: number;
  array_cap?: number;
}

export function sampleObject(value: unknown, opts: SampleOptions = {}): unknown {
  const depth = opts.depth ?? LLM_TOOL_RESULT_SAMPLE_DEPTH;
  const array_cap = opts.array_cap ?? LLM_TOOL_RESULT_ARRAY_CAP;
  return walk(value, depth, array_cap);
}

function walk(value: unknown, remaining: number, array_cap: number): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (remaining <= 0) {
      return {
        [SAMPLE_MARKER_TRUNCATED_KIND]: "array",
        [SAMPLE_MARKER_TRUNCATED_COUNT]: value.length,
      };
    }
    const out: unknown[] = [];
    const limit = Math.min(value.length, array_cap);
    for (let i = 0; i < limit; i += 1) {
      out.push(walk(value[i], remaining - 1, array_cap));
    }
    if (value.length > array_cap) {
      out.push({
        [SAMPLE_MARKER_TRUNCATED_KIND]: "array",
        [SAMPLE_MARKER_TRUNCATED_COUNT]: value.length - array_cap,
      });
    }
    return out;
  }
  if (typeof value === "object") {
    if (remaining <= 0) {
      const keys = Object.keys(value as Record<string, unknown>).length;
      return {
        [SAMPLE_MARKER_TRUNCATED_KIND]: "object",
        [SAMPLE_MARKER_TRUNCATED_KEYS]: keys,
      };
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      out[key] = walk(src[key], remaining - 1, array_cap);
    }
    return out;
  }
  return value;
}
