import {
  LLM_TOOL_RESULT_ARRAY_CAP,
  LLM_TOOL_RESULT_ERROR_BYTES,
  LLM_TOOL_RESULT_SAMPLE_DEPTH,
  LLM_TOOL_RESULT_SUCCESS_BYTES,
} from "../../execution/timeouts.ts";
import { sampleObject } from "../../utils/sample-object.ts";

type ToolResultKind = "success" | "error";

interface TruncationMeta {
  original_bytes: number;
  sample_depth: number;
  array_cap: number;
  reason: string;
}

interface TruncatedToolResult {
  value: unknown;
  truncated: TruncationMeta | null;
}

interface TruncateOptions {
  success_bytes?: number;
  error_bytes?: number;
  depth?: number;
  array_cap?: number;
}

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
  return { value: result.value, _truncated: result.truncated };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}
