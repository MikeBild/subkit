// Tool-result truncation policy.
//
// Tools the LLM calls during a conversation routinely return payloads
// that — at full size — would blow the model's context window or push
// the truly-relevant information past the cache-block boundary. The
// fix is *not* to ask the model to be terse; it is to enforce a hard
// budget at the boundary and surface a structured marker so the model
// can request a focused subset on the next turn.
//
// Two budgets:
//
//   - `LLM_TOOL_RESULT_SUCCESS_BYTES` — successful results have the most
//     business value, get the largest budget (80 KB by default).
//   - `LLM_TOOL_RESULT_ERROR_BYTES` — errors tend to repeat themselves,
//     get the smaller budget (50 KB).
//
// When truncation fires, the returned object gains a `_truncated`
// marker:
//
//   {
//     ...sampled,
//     _truncated: {
//       original_bytes: 124_312,
//       sample_depth: 3,
//       array_cap: 100,
//       reason: "exceeded_success_bytes",
//     }
//   }
//
// The shape of `sampled` is whatever `sampleObject` produces from the
// original — typically a 3-level-deep object with arrays capped at 100
// entries. Primitives below the budget pass through unchanged.

import {
  LLM_TOOL_RESULT_ARRAY_CAP,
  LLM_TOOL_RESULT_ERROR_BYTES,
  LLM_TOOL_RESULT_SAMPLE_DEPTH,
  LLM_TOOL_RESULT_SUCCESS_BYTES,
} from "../../execution/timeouts.ts";
import { sampleObject } from "../../utils/sample-object.ts";

export type ToolResultKind = "success" | "error";

export interface TruncationMeta {
  original_bytes: number;
  sample_depth: number;
  array_cap: number;
  reason: string;
}

export interface TruncatedToolResult {
  /** The (possibly sampled) value the LLM should consume. */
  value: unknown;
  /** Truncation metadata; null when the value was small enough to pass
   *  through verbatim. */
  truncated: TruncationMeta | null;
}

export interface TruncateOptions {
  /** Override the default success budget. Useful for tools that produce
   *  intentionally-large payloads (e.g. raw HTTP responses). */
  success_bytes?: number;
  /** Override the default error budget. */
  error_bytes?: number;
  /** Override sample depth. */
  depth?: number;
  /** Override array cap. */
  array_cap?: number;
}

/** Apply the tool-result truncation policy to an LLM-bound value.
 *  Returns the (possibly sampled) value plus a metadata block that the
 *  caller can attach as a sibling field if it wants the LLM to see the
 *  truncation marker. */
export function truncateToolResult(
  value: unknown,
  kind: ToolResultKind,
  opts: TruncateOptions = {},
): TruncatedToolResult {
  const budget =
    kind === "success"
      ? (opts.success_bytes ?? LLM_TOOL_RESULT_SUCCESS_BYTES)
      : (opts.error_bytes ?? LLM_TOOL_RESULT_ERROR_BYTES);
  const depth = opts.depth ?? LLM_TOOL_RESULT_SAMPLE_DEPTH;
  const array_cap = opts.array_cap ?? LLM_TOOL_RESULT_ARRAY_CAP;

  const serialized = safeStringify(value);
  const original_bytes = serialized.length;
  if (original_bytes <= budget) {
    return { value, truncated: null };
  }
  const sampled = sampleObject(value, { depth, array_cap });
  return {
    value: sampled,
    truncated: {
      original_bytes,
      sample_depth: depth,
      array_cap,
      reason: kind === "success" ? "exceeded_success_bytes" : "exceeded_error_bytes",
    },
  };
}

/** Convenience wrapper that produces the LLM-facing object directly,
 *  embedding the `_truncated` marker as a sibling field. Use when the
 *  caller wants a single value to splice into the tool-result history
 *  rather than a `{ value, truncated }` pair. */
export function truncatedToolResultValue(
  value: unknown,
  kind: ToolResultKind,
  opts: TruncateOptions = {},
): unknown {
  const result = truncateToolResult(value, kind, opts);
  if (!result.truncated) return result.value;
  if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
    return { ...(result.value as Record<string, unknown>), _truncated: result.truncated };
  }
  // For non-object values we wrap so the marker still travels with the
  // payload. The caller can unwrap if it knows the shape.
  return { value: result.value, _truncated: result.truncated };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    // Cyclic structures or BigInts — fall back to a coarse representation
    // so the caller still gets a usable byte count.
    return String(value);
  }
}
