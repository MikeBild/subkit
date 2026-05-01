// critic — terminal-step rubric pass.
//
// Runs after the converse loop hits any of its terminal stop
// conditions (committedStopCondition, pausedStopCondition, or
// stepCountIs with a non-paused state). Delegates to a per-kind
// deterministic rubric that grades the artifact against structural
// predicates and returns a verdict. The loop:
//   - logs the verdict (info-level, audit-friendly),
//   - flips `priorCriticFail` so the NEXT turn escalates one tier up,
//   - on low confidence + commit, surfaces an `ask_user_text` follow-up
//     elicitation so the operator can confirm the commit before acting.
//
// The rubrics are deterministic predicates by design — every question
// they answer is structural (is the field present? does the text contain
// a placeholder marker? is the referenced id in the snapshot?).
// Deterministic checks are faster (no second LLM call), cheaper, and
// more reliable than LLM-as-judge for structural criteria.

import type { SubkitLlm } from "../core/base-types.ts";
import { chatRubric } from "./rubrics/chat.ts";
import type { SaveWorkflowDraftArtifact } from "./rubrics/save-workflow-draft.ts";
import { saveWorkflowDraftRubric } from "./rubrics/save-workflow-draft.ts";

export type CriticKind = "save_workflow_draft" | "chat";

export type CriticArtifact =
  | { kind: "save_workflow_draft"; payload: SaveWorkflowDraftArtifact }
  | { kind: "chat"; payload: string };

export interface CriticVerdict {
  verdict: "pass" | "fail";
  /** 0..1 — below 0.6 the loop should surface an ask_user_text follow-up. */
  confidence: number;
  /** Why the verdict came out this way. Surfaced to the model on revise. */
  reason: string;
  /** Concrete fix the model should apply on the revision pass. */
  hint?: string;
  /** Per-question outcomes for telemetry / audit. */
  checks?: Record<string, boolean>;
}

export interface RunCriticParams {
  artifact: CriticArtifact;
  /** Tenant snapshot text for grounding (id presence checks). */
  snapshot?: string;
  /** Optional runtime context (engine_url, tenant_slug) for chat grounding. */
  runtimeContext?: { engine_url?: string; tenant_slug?: string };
  /** Tenant default LLM, already initialised. Reserved for future LLM-grading. */
  llm?: SubkitLlm;
}

const PLACEHOLDER_MARKER = /\[guard:/;

function inSnapshot(snapshot: string | undefined, value: string): boolean {
  if (!snapshot || !value) return true;
  return snapshot.includes(value);
}

function gradeSaveWorkflowDraft(
  payload: SaveWorkflowDraftArtifact,
  snapshot: string | undefined,
): CriticVerdict {
  const checks = {
    saved: typeof payload.resource_id === "string" && payload.resource_id.length > 0,
    auth_or_trigger_defined:
      payload.resource_kind === "connector"
        ? typeof payload.connector_auth_mode === "string" && payload.connector_auth_mode.length > 0
        : typeof payload.workflow_trigger_kind === "string" &&
          payload.workflow_trigger_kind.length > 0 &&
          payload.workflow_trigger_kind !== "unknown",
    validated_step_present: payload.validated_step_count >= 1,
    no_placeholder_markers: !PLACEHOLDER_MARKER.test(payload.committed_text),
    credentials_exist: payload.referenced_credentials.every((c) => inSnapshot(snapshot, c)),
  };
  const failed = Object.entries(checks).filter(([, v]) => v === false);
  if (failed.length === 0) {
    return {
      verdict: "pass",
      confidence: 1,
      reason: "all rubric checks passed",
      checks,
    };
  }
  const failedKeys = failed.map(([k]) => k);
  const confidence = Math.max(0, 1 - failed.length * 0.25);
  return {
    verdict: "fail",
    confidence,
    reason: `save_workflow_draft rubric failed: ${failedKeys.join(", ")}`,
    hint: hintForSaveWorkflowDraft(failedKeys),
    checks,
  };
}

function hintForSaveWorkflowDraft(failed: string[]): string {
  const parts: string[] = [];
  if (failed.includes("saved"))
    parts.push("call save_connector_draft / save_workflow_draft to persist before signalling done");
  if (failed.includes("no_placeholder_markers"))
    parts.push("replace [guard:placeholder] markers with grounded values from runtime_context");
  if (failed.includes("credentials_exist"))
    parts.push(
      "every referenced credential id must already exist in the tenant snapshot before commit",
    );
  if (failed.includes("auth_or_trigger_defined"))
    parts.push("define the auth flow (connector) or trigger (workflow) before committing");
  if (failed.includes("validated_step_present"))
    parts.push("validate at least one step (dry_run_step or validate_draft) before committing");
  return parts.join("; ");
}

// Match real subkit ids — UUID v4-shaped, case-insensitive. The earlier
// `/\b(connector|workflow)_[a-z0-9_]+\b/` pattern was a no-op against
// production data because subkit ids are bare UUIDs, not prefixed
// strings.
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function gradeChat(
  text: string,
  snapshot: string | undefined,
  runtimeContext: { engine_url?: string; tenant_slug?: string } | undefined,
): CriticVerdict {
  const matches = text.match(UUID_PATTERN) ?? [];
  const ungroundedIds = snapshot ? matches.filter((m) => !snapshot.includes(m)) : [];
  const checks = {
    ids_grounded: ungroundedIds.length === 0,
    runtime_values_consistent:
      runtimeContext === undefined ||
      ((!runtimeContext.engine_url || !text.includes("https://your-")) &&
        (!runtimeContext.tenant_slug || !text.includes("your-tenant"))),
    no_placeholder_markers: !PLACEHOLDER_MARKER.test(text),
  };
  const failed = Object.entries(checks).filter(([, v]) => v === false);
  if (failed.length === 0) {
    return {
      verdict: "pass",
      confidence: 1,
      reason: "all rubric checks passed",
      checks,
    };
  }
  const failedKeys = failed.map(([k]) => k);
  const confidence = Math.max(0, 1 - failed.length * 0.3);
  const hintParts: string[] = [];
  if (ungroundedIds.length > 0)
    hintParts.push(
      `these ids are not in the tenant snapshot: ${ungroundedIds.slice(0, 3).join(", ")}`,
    );
  if (failed.some(([k]) => k === "runtime_values_consistent"))
    hintParts.push(
      "use the runtime_context block (engine_url, tenant_slug) instead of placeholders",
    );
  if (failed.some(([k]) => k === "no_placeholder_markers"))
    hintParts.push("replace [guard:placeholder] markers with grounded values");
  return {
    verdict: "fail",
    confidence,
    reason: `chat rubric failed: ${failedKeys.join(", ")}`,
    hint: hintParts.join("; "),
    checks,
  };
}

/**
 * Run the critic for a terminal step's artifact.
 */
export async function runCritic(params: RunCriticParams): Promise<CriticVerdict> {
  const { artifact, snapshot, runtimeContext } = params;
  switch (artifact.kind) {
    case "save_workflow_draft":
      return gradeSaveWorkflowDraft(artifact.payload, snapshot);
    case "chat":
      return gradeChat(artifact.payload, snapshot, runtimeContext);
  }
}

export { chatRubric, saveWorkflowDraftRubric };
