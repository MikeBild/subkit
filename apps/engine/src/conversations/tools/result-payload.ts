import type { ToolResult } from "./index.ts";

export function normalizeToolResultPayload(result: ToolResult): unknown {
  if (result.ok) return result.data;
  if (result.data !== undefined) {
    if (typeof result.data === "object" && result.data !== null) {
      return {
        ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.data as Record<string, unknown>),
      };
    }
    return result.data;
  }
  return {
    ok: false,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.next_best_actions !== undefined
      ? { next_best_actions: result.next_best_actions }
      : {}),
  };
}

export type ToolCallOutcome = "ok" | "error" | "denied" | "pending";

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
