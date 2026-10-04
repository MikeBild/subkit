import type { ToolResultPause } from "../index.ts";

export const MAX_TURN_LOOP_WARNINGS = 2;

export const MAX_CONSECUTIVE_FAILURES = 5;

export const MAX_VALIDATION_FINGERPRINT_REPEAT = 3;

export const MAX_ERROR_CODE_REPEAT = 4;

export interface TurnSignals {
  pendingElicitation?: {
    elicitation_id: string;
    tool_name: string;
    kind?: string;
    summary: string;
    input?: unknown;
    diff?: unknown;
    target?: unknown;
  };
  committed?: {
    workflow_id: string;
  };
  step: number;
  toolChain: Promise<void>;
  assistantMessageId?: string | null;
  lastAssistantMessageId?: string | null;
  pendingChildToolCallIds: string[];
  pendingChildElicitationIds: string[];
  toolInvocationCount: Map<string, number>;
  toolLastErrorHash: Map<string, string>;
  toolArgsRepeat: Map<string, { hash: string; count: number }>;
  toolValidationFingerprint: Map<string, { hash: string; count: number }>;
  toolErrorCodeRepeat: Map<string, { code: string; count: number }>;
  totalLoopWarnings: number;
  consecutiveFailures: number;
  lastAssistantText: string;
  lastExecutionSuccess: { tool: string; args_hash: string; output: unknown } | null;
}

export interface WrappedToolOutput {
  ok: boolean;
  data: unknown;
  pause?: ToolResultPause;
  committed_workflow_id?: string;
}

export function computeValidationFingerprint(
  errors: Array<{ path?: unknown; message?: unknown }>,
): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const tuples: string[] = [];
  for (const e of errors) {
    const path = typeof e.path === "string" ? e.path : "";
    const rawMsg = typeof e.message === "string" ? e.message : "";
    if (!path && !rawMsg) continue;
    const stripped = rawMsg
      .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replace(/\b\d+\b/g, "<n>")
      .slice(0, 60);
    tuples.push(`${path}::${stripped}`);
  }
  if (tuples.length === 0) return null;
  return tuples.sort().join("|");
}
