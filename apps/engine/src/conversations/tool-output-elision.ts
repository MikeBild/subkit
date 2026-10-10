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

export interface CriticalToolOutputStub extends ElidedToolOutputStub {
  _critical: true;
  ok?: false;
  error_code?: string;
  message?: string;
  writes_held?: true;
  held_step_ids?: string[];
  status?: string;
  execution_id?: string;
  workflow_id?: string;
  workflow_version_id?: string;
  resource_id?: string;
  resource_ids?: string[];
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

export function buildCriticalToolOutputStub(args: {
  tool: string;
  ref: string;
  original_size: number;
  size_unit: "bytes" | "chars";
  output: unknown;
}): CriticalToolOutputStub {
  const source = criticalEvidenceSource(args.output);
  const stub: CriticalToolOutputStub = {
    ...buildElidedToolOutputStub(args),
    _critical: true,
  };
  if (source?.ok === false) stub.ok = false;
  if (source?.writes_held === true) stub.writes_held = true;
  for (const key of [
    "error_code",
    "status",
    "execution_id",
    "workflow_id",
    "workflow_version_id",
    "resource_id",
  ] as const) {
    if (typeof source?.[key] === "string") stub[key] = source[key];
  }
  for (const key of ["held_step_ids", "resource_ids"] as const) {
    if (Array.isArray(source?.[key])) {
      stub[key] = source[key]
        .filter((value): value is string => typeof value === "string")
        .slice(0, 50);
    }
  }
  if (typeof source?.message === "string") stub.message = source.message.slice(0, 500);
  return stub;
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

export function isReplayCriticalToolOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.ok === false ||
    record.writes_held === true ||
    typeof record.error_code === "string" ||
    record.status === "failed"
  ) {
    return true;
  }
  const data = record.data;
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    isReplayCriticalToolOutput(data)
  );
}

function criticalEvidenceSource(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.ok === false ||
    record.writes_held === true ||
    typeof record.error_code === "string" ||
    record.status === "failed"
  ) {
    return record;
  }
  const data = record.data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
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
      const stub = isReplayCriticalToolOutput(value)
        ? buildCriticalToolOutputStub({
            tool: part.toolName,
            ref,
            original_size: size,
            size_unit: "chars",
            output: value,
          })
        : buildElidedToolOutputStub({
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
