import { isDeepStrictEqual } from "node:util";

export type ExecutionBinding = "held" | "authorized" | "unbound";

export interface ExecutionBoundary {
  binding: ExecutionBinding;
  execution_authority_id: string | null;
  workflow_id: string;
  workflow_version_id: string | null;
  execution_mode: string;
  parent_execution_id: string | null;
  caller_context: unknown;
  caller_origin: string;
  input: unknown;
}

interface PersistedExecutionBoundary {
  hold_writes: boolean;
  execution_authority_id: string | null;
  workflow_id: string | null;
  workflow_version_id: string | null;
  execution_mode: string;
  parent_execution_id: string | null;
  caller_context: unknown;
  caller_origin: string | null;
}

export function bindingOf(row: {
  hold_writes: boolean;
  execution_authority_id: string | null;
}): ExecutionBinding {
  if (row.execution_authority_id) return "authorized";
  return row.hold_writes ? "held" : "unbound";
}

export function boundaryOfExecution(
  row: PersistedExecutionBoundary,
  input: unknown,
): ExecutionBoundary {
  return {
    binding: bindingOf(row),
    execution_authority_id: row.execution_authority_id,
    workflow_id: row.workflow_id ?? "",
    workflow_version_id: row.workflow_version_id,
    execution_mode: row.execution_mode,
    parent_execution_id: row.parent_execution_id ?? null,
    caller_context: row.caller_context,
    caller_origin: row.caller_origin ?? "",
    input,
  };
}

export function sameExecutionBoundary(a: ExecutionBoundary, b: ExecutionBoundary): boolean {
  return (
    a.binding === b.binding &&
    a.execution_authority_id === b.execution_authority_id &&
    a.workflow_id === b.workflow_id &&
    a.workflow_version_id === b.workflow_version_id &&
    a.execution_mode === b.execution_mode &&
    a.parent_execution_id === b.parent_execution_id &&
    a.caller_origin === b.caller_origin &&
    isDeepStrictEqual(a.caller_context, b.caller_context) &&
    isDeepStrictEqual(a.input, b.input)
  );
}

export interface AdmissionRequest {
  workflow_id: string;
  workflow_version_id?: string | undefined;
  expected_workflow_version_id?: string | undefined;
  execution_authority_id?: string | undefined;
  hold_writes?: boolean | undefined;
}

export type InputSchemaVerdict = { valid: true } | { valid: false; errors: string[] };

export type AdmissionFacts =
  | { stage: "requested_version" }
  | { stage: "lifecycle"; lifecycle: string | null }
  | { stage: "binding" }
  | { stage: "authority_refusal"; code: string | null; message: string }
  | { stage: "held_model_steps"; model_step_ids: readonly string[] }
  | { stage: "input"; verdict: InputSchemaVerdict }
  | { stage: "replay_candidate"; workflow_id: string | null; workflow_version_id: string | null }
  | { stage: "replay"; existing: ExecutionBoundary | null; requested: ExecutionBoundary }
  | { stage: "active_version"; lifecycle: string | null; current_version_id: string | null }
  | { stage: "active_definition"; found: boolean }
  | { stage: "repeated_runs"; eligible: boolean }
  | { stage: "authority"; refusal: { code: string; message: string } | null };

export type AdmissionDecision =
  | { kind: "admitted" }
  | { kind: "replay" }
  | { kind: "downgrade" }
  | { kind: "rejected"; code: string; message: string };

export const DOWNGRADABLE_AUTHORITY_CODES: ReadonlySet<string> = new Set([
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "workflow_version_not_active",
  "execution_boundary_mismatch",
]);

const ADMITTED: AdmissionDecision = { kind: "admitted" };

function rejected(code: string, message: string): AdmissionDecision {
  return { kind: "rejected", code, message };
}

const BOUNDARY_MISMATCH = "the idempotency key belongs to a different execution boundary";

export function decideAdmission(
  request: AdmissionRequest,
  facts: AdmissionFacts,
): AdmissionDecision {
  switch (facts.stage) {
    case "requested_version":
      return request.expected_workflow_version_id &&
        request.workflow_version_id &&
        request.expected_workflow_version_id !== request.workflow_version_id
        ? rejected(
            "execution_boundary_mismatch",
            "the prepared workflow version differs from the requested workflow version",
          )
        : ADMITTED;
    case "lifecycle":
      return facts.lifecycle === "archived"
        ? rejected(
            "workflow_archived",
            "this workflow is archived and cannot run until it is restored",
          )
        : ADMITTED;
    case "binding":
      return request.hold_writes === true && request.execution_authority_id
        ? rejected(
            "execution_boundary_mismatch",
            "a preparation request cannot also select a live authority",
          )
        : ADMITTED;
    case "authority_refusal": {
      const code = facts.code ?? "";
      return request.execution_authority_id ||
        request.hold_writes === false ||
        request.expected_workflow_version_id ||
        !DOWNGRADABLE_AUTHORITY_CODES.has(code)
        ? rejected(code, facts.message)
        : { kind: "downgrade" };
    }
    case "held_model_steps":
      return facts.model_step_ids.length > 0
        ? rejected(
            "execution_authority_required",
            `this workflow sends step data to the AI model (${facts.model_step_ids.join(", ")}); it runs only under an approved execution authority`,
          )
        : ADMITTED;
    case "input":
      return facts.verdict.valid
        ? ADMITTED
        : rejected("input_schema_violation", facts.verdict.errors.join("; "));
    case "replay_candidate":
      return facts.workflow_id !== request.workflow_id || !facts.workflow_version_id
        ? rejected("execution_boundary_mismatch", BOUNDARY_MISMATCH)
        : ADMITTED;
    case "replay":
      if (!facts.existing) return ADMITTED;
      return sameExecutionBoundary(facts.existing, facts.requested)
        ? { kind: "replay" }
        : rejected("execution_boundary_mismatch", BOUNDARY_MISMATCH);
    case "active_version":
      return facts.lifecycle !== "active" ||
        !facts.current_version_id ||
        (request.workflow_version_id && request.workflow_version_id !== facts.current_version_id)
        ? rejected(
            "workflow_version_not_active",
            "only the exact active workflow version can be admitted",
          )
        : ADMITTED;
    case "active_definition":
      return facts.found
        ? ADMITTED
        : rejected("workflow_version_not_active", "active workflow version unavailable");
    case "repeated_runs":
      return facts.eligible
        ? ADMITTED
        : rejected(
            "execution_authority_required",
            "this workflow requires concrete-run review for its current effects",
          );
    case "authority":
      return facts.refusal ? rejected(facts.refusal.code, facts.refusal.message) : ADMITTED;
  }
}
