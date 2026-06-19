// Depth-limited structural sampling.
//
// Used by `llm/core/tool-result-truncate.ts` to give the LLM a
// representative-but-bounded view of an oversized tool result, and by
// `execution/offload.ts`'s preview path for operator-facing previews.
//
// The sampler walks an arbitrary JSON-shaped value:
//
//   - Arrays beyond `LLM_TOOL_RESULT_ARRAY_CAP` are truncated. The first
//     N entries survive; the array gets a `_truncated_count` marker
//     describing how many were dropped.
//   - Objects beyond `depth` collapse to a single typed placeholder
//     (`{ "_truncated_kind": "object", "_truncated_keys": <n> }`) so the
//     consumer sees the shape without the bulk.
//   - Primitive leaves pass through unchanged.
//
// The sampler never throws and never reads from the input outside its
// own walk — it's safe to apply to opaque tool-result envelopes.

import { LLM_TOOL_RESULT_ARRAY_CAP, LLM_TOOL_RESULT_SAMPLE_DEPTH } from "../execution/timeouts.ts";

/** Marker key family used to tell the consumer (LLM or operator) that
 *  data was elided. Names are deliberately verbose so they are visually
 *  obvious in serialized output and unlikely to collide with real keys. */
export const SAMPLE_MARKER_TRUNCATED_COUNT = "_truncated_count";
export const SAMPLE_MARKER_TRUNCATED_KIND = "_truncated_kind";
export const SAMPLE_MARKER_TRUNCATED_KEYS = "_truncated_keys";

export interface SampleOptions {
  /** Maximum object depth before deep branches collapse. Default
   *  `LLM_TOOL_RESULT_SAMPLE_DEPTH`. */
  depth?: number;
  /** Maximum array length before excess entries are dropped. Default
   *  `LLM_TOOL_RESULT_ARRAY_CAP`. */
  array_cap?: number;
}

/** Produce a depth-limited copy of `value` according to `opts`. The
 *  returned value is a fresh structure — the input is never mutated. */
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
