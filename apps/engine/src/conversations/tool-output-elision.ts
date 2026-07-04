// Shared tool-output elision — ONE stub convention for both replay
// paths that bound prompt growth:
//
//   1. Cross-turn (persist.buildModelMessages): tool outputs older than
//      TOOL_OUTPUT_VERBATIM_TURNS user-turns are replaced with a stub.
//   2. Within-turn (loop.ts prepareStep): tool outputs produced by the
//      live agentic loop that are more than WITHIN_TURN_VERBATIM_ITERATIONS
//      iterations old are replaced with the same stub before the next
//      LLM call.
//
// Both stubs carry a `_raw_ref` so the model can recover the full
// payload via the existing `get_raw_result(ref)` tool. The stub text is
// identical across paths so the model recognises it regardless of where
// the elision happened.
//
// The bug the within-turn path fixes (session 784c1b02): a turn with
// 40+ agentic iterations re-sent the FULL tool-output history on every
// LLM call — persist.ts only elides across user-turns, nothing bounded
// the live turn — burning 3.9M tokens in a single session.

import type { ModelMessage } from "ai";
import { rememberRaw } from "./tools/truncate.ts";

/** Serialized tool outputs above this size are elided when they fall
 *  outside the verbatim window (shared by both replay paths). */
export const TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS = 4000;

/** Within the live turn, tool results from the most recent N agentic
 *  iterations stay verbatim; older bulky ones are stubbed. One
 *  iteration == one tool-role message (parallel tool calls are
 *  disabled at the provider layer, so each step yields at most one). */
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

/**
 * The canonical elision stub. `size_unit` keeps the persisted-stub
 * wording stable: the SQL projection path measures octet_length
 * ("bytes"), the in-process paths measure JSON.stringify length
 * ("chars").
 */
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
  /** Tool-result payloads replaced with stubs in this pass. */
  elided_count: number;
  /** Sum of serialized chars removed from the next prompt. */
  elided_chars: number;
}

/**
 * Within-turn elision over the message set the SDK is about to send.
 * `baseline_index` marks where the live turn's response messages start
 * (everything before it is replayed history that persist.ts already
 * bounded — left untouched here). Tool-role messages from index
 * `baseline_index` onward count as agentic iterations; all but the
 * most recent `keep_last_iterations` get their bulky (>`threshold_chars`
 * serialized) tool-result payloads replaced with the canonical stub.
 *
 * Deterministic: the same message set always elides the same payloads.
 * Returns null when nothing crossed the threshold (caller skips the
 * override and the SDK sends its own messages unchanged). Copy-on-write:
 * the input array and untouched messages are never mutated.
 */
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

  // Indices of live-turn tool-role messages, oldest → newest.
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
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    let contentChanged = false;
    const nextContent = msg.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output;
      if (output.type !== "json" && output.type !== "text") return part;
      const value = output.value;
      if (isElidedStub(value)) return part;
      const size = typeof value === "string" ? value.length : approxValueSize(value);
      if (size <= threshold) return part;
      // Reuse the ref `truncateForLlm` minted on the way in when the
      // payload was already truncated once; otherwise stash the live
      // value so `get_raw_result` can recover it.
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
