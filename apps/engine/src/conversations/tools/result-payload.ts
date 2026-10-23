import type { ToolResult } from "./index.ts";

export const GENERIC_TOOL_FAILURE_CODE = "tool_failed";

const GENERIC_TOOL_FAILURE_MESSAGE = "the tool reported a failure without details";

const CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

export interface ToolFailureEnvelope {
  error_code: string;
  message: string;
  next_best_actions: string[];
}

type FailedToolResult = Extract<ToolResult, { ok: false }>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codeOf(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && CODE_PATTERN.test(text) ? text : undefined;
}

function proseOf(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && !CODE_PATTERN.test(text) ? text : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function firstErrorMessage(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const message =
      typeof entry === "object" && entry !== null
        ? nonEmptyString((entry as { message?: unknown }).message)
        : nonEmptyString(entry);
    if (message) return message;
  }
  return undefined;
}

export function toolFailureEnvelope(result: FailedToolResult): ToolFailureEnvelope {
  const data =
    typeof result.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : {};
  const details =
    typeof result.details === "object" && result.details !== null
      ? (result.details as Record<string, unknown>)
      : {};
  const nested =
    typeof data.error === "object" && data.error !== null
      ? (data.error as Record<string, unknown>)
      : {};
  const errorCode =
    nonEmptyString(data.error_code) ??
    nonEmptyString(result.error_code) ??
    nonEmptyString(details.error_code) ??
    codeOf(data.error) ??
    codeOf(nested.code) ??
    codeOf(data.reason) ??
    GENERIC_TOOL_FAILURE_CODE;
  const message =
    nonEmptyString(data.message) ??
    nonEmptyString(result.message) ??
    nonEmptyString(details.message) ??
    proseOf(data.error) ??
    nonEmptyString(data.hint) ??
    nonEmptyString(nested.message) ??
    proseOf(data.reason) ??
    firstErrorMessage(data.errors) ??
    nonEmptyString(result.data) ??
    (errorCode === GENERIC_TOOL_FAILURE_CODE ? GENERIC_TOOL_FAILURE_MESSAGE : errorCode);
  const nextBestActions =
    stringList(data.next_best_actions) ??
    result.next_best_actions ??
    stringList(details.next_best_actions) ??
    [];
  return { error_code: errorCode, message, next_best_actions: nextBestActions };
}

export function normalizeToolResultPayload(result: ToolResult): unknown {
  if (result.ok) return result.data;
  if (result.pause !== undefined && result.data !== undefined) return result.data;
  const envelope = toolFailureEnvelope(result);
  const data =
    typeof result.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : { ok: false };
  return {
    ...data,
    error_code: envelope.error_code,
    message: envelope.message,
    ...(result.details !== undefined && data.details === undefined
      ? { details: result.details }
      : {}),
    next_best_actions: envelope.next_best_actions,
  };
}

export type ToolCallOutcome = "ok" | "error" | "denied" | "expired" | "pending";

const DENIAL_CODES = ["permission_denied", "policy_confirm_required", "not_available_on_surface"];

function isDenialCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return DENIAL_CODES.some((code) => value === code || value.startsWith(`${code}:`));
}

export function toolCallOutcome(result: ToolResult): ToolCallOutcome {
  if (result.pause !== undefined) return "pending";
  if (result.ok) return "ok";
  if (isDenialCode(result.error_code)) return "denied";
  const data = result.data;
  if (typeof data === "object" && data !== null) {
    const rec = data as Record<string, unknown>;
    if (rec.denied === true) return "denied";
    if (isDenialCode(rec.error_code)) return "denied";
    if (isDenialCode(rec.error)) return "denied";
    const nested = rec.error;
    if (typeof nested === "object" && nested !== null) {
      if (isDenialCode((nested as Record<string, unknown>).code)) return "denied";
    }
  }
  return "error";
}
