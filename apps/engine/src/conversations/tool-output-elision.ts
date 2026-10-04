import type { ModelMessage } from "ai";
import { rememberRaw } from "./tools/truncate.ts";

export const TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS = 4000;

export const WITHIN_TURN_VERBATIM_ITERATIONS = 5;

export function approxValueSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export interface ElidedToolOutputStub {
  _elided: true;
  _tool: string;
  _raw_ref: string;
  _note: string;
  [key: string]: unknown;
}

export function buildElidedToolOutputStub(args: {
  tool: string;
  ref: string;
  original_size: number;
  size_unit: "bytes" | "chars";
}): ElidedToolOutputStub {
  return {
    _elided: true,
    _tool: args.tool,
    _raw_ref: args.ref,
    _note: `<elided: tool=${args.tool}, ref=${args.ref}, original=${args.original_size} ${args.size_unit}; call get_raw_result(ref="${args.ref}") for the full payload>`,
  };
}

function isElidedStub(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)._elided === true
  );
}

function existingRawRef(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = (value as Record<string, unknown>)._raw_ref;
  return typeof ref === "string" ? ref : null;
}

export interface WithinTurnElisionResult {
  messages: ModelMessage[];
  elided_count: number;
  elided_chars: number;
}

export function elideWithinTurnToolOutputs(
  messages: ModelMessage[],
  opts: {
    baseline_index: number;
    keep_last_iterations?: number;
    threshold_chars?: number;
  },
): WithinTurnElisionResult | null {
  const keepLast = opts.keep_last_iterations ?? WITHIN_TURN_VERBATIM_ITERATIONS;
  const threshold = opts.threshold_chars ?? TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS;
  const baseline = Math.max(0, opts.baseline_index);

  const toolMessageIndices: number[] = [];
  for (let i = baseline; i < messages.length; i++) {
    if (messages[i]?.role === "tool") toolMessageIndices.push(i);
  }
  if (toolMessageIndices.length <= keepLast) return null;

  const elidable = new Set(toolMessageIndices.slice(0, toolMessageIndices.length - keepLast));
  let elidedCount = 0;
  let elidedChars = 0;
  let out: ModelMessage[] | null = null;

  for (const idx of elidable) {
    const msg = messages[idx];
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) continue;
    let contentChanged = false;
    const nextContent = msg.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output;
      if (output.type !== "json" && output.type !== "text") return part;
      const value = output.value;
      if (isElidedStub(value)) return part;
      const size = typeof value === "string" ? value.length : approxValueSize(value);
      if (size <= threshold) return part;
      const ref = existingRawRef(value) ?? rememberRaw(value);
      const stub = buildElidedToolOutputStub({
        tool: part.toolName,
        ref,
        original_size: size,
        size_unit: "chars",
      });
      contentChanged = true;
      elidedCount += 1;
      elidedChars += size;
      return { ...part, output: { type: "json" as const, value: stub } };
    });
    if (!contentChanged) continue;
    if (out === null) out = [...messages];
    out[idx] = { ...msg, content: nextContent } as ModelMessage;
  }

  if (out === null || elidedCount === 0) return null;
  return { messages: out, elided_count: elidedCount, elided_chars: elidedChars };
}
