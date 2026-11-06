import type { SubkitLlm } from "../core/base-types.ts";
import { pendingPermittedRemedy } from "../core/permitted-remedy.ts";
import { type CountIssue, detectCountInconsistencies } from "./count-consistency.ts";
import { chatRubric } from "./rubrics/chat.ts";
import type { SaveWorkflowDraftArtifact } from "./rubrics/save-workflow-draft.ts";
import { saveWorkflowDraftRubric } from "./rubrics/save-workflow-draft.ts";
import {
  type CriticToolResult,
  detectToolClaimMismatches,
  summarizeToolResult,
  type ToolClaimIssue,
  toolResultIds,
} from "./tool-claims.ts";

export type CriticArtifact =
  | { kind: "save_workflow_draft"; payload: SaveWorkflowDraftArtifact }
  | { kind: "chat"; payload: string };

export interface CriticVerdict {
  verdict: "pass" | "fail";
  confidence: number;
  reason: string;
  hint?: string;
  checks?: Record<string, boolean>;
}

interface RunCriticParams {
  artifact: CriticArtifact;
  snapshot?: string;
  runtimeContext?: { engine_url?: string; tenant_slug?: string };
  toolResults?: ReadonlyArray<CriticToolResult>;
  availableTools?: ReadonlyArray<string>;
  readOnlyTools?: ReadonlyArray<string>;
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

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function untakenRemedy(
  toolResults: ReadonlyArray<CriticToolResult>,
  availableTools: ReadonlyArray<string>,
  readOnlyTools: ReadonlyArray<string>,
): string[] {
  return pendingPermittedRemedy(
    toolResults.map((result) => ({
      tool: result.tool,
      output: result.ok
        ? { ok: true }
        : {
            ok: false,
            ...(result.error_code ? { error_code: result.error_code } : {}),
            next_best_actions: result.next_best_actions ?? [],
          },
    })),
    new Set(availableTools),
    { questionAnswers: true, readOnly: (name) => readOnlyTools.includes(name) },
  );
}

function gradeChat(
  text: string,
  snapshot: string | undefined,
  runtimeContext: { engine_url?: string; tenant_slug?: string } | undefined,
  toolResults: ReadonlyArray<CriticToolResult> | undefined,
  availableTools: ReadonlyArray<string> | undefined,
  readOnlyTools: ReadonlyArray<string>,
): CriticVerdict {
  const matches = text.match(UUID_PATTERN) ?? [];
  const resultIds = toolResultIds(toolResults ?? []);
  const ungroundedIds = snapshot
    ? matches.filter((m) => !snapshot.includes(m) && !resultIds.has(m.toLowerCase()))
    : [];
  const countIssues: CountIssue[] = detectCountInconsistencies(text);
  const claimIssues: ToolClaimIssue[] = toolResults
    ? detectToolClaimMismatches(text, toolResults)
    : [];
  const claimChecks = toolResults
    ? {
        tool_counts_match: !claimIssues.some((i) => i.kind === "count_mismatch"),
        no_success_after_failure: !claimIssues.some((i) => i.kind === "success_after_failure"),
        processed_ids_in_results: !claimIssues.some((i) => i.kind === "unprocessed_id"),
      }
    : {};
  const remedy = availableTools
    ? untakenRemedy(toolResults ?? [], availableTools, readOnlyTools)
    : [];
  const remedyChecks = availableTools ? { permitted_next_action_taken: remedy.length === 0 } : {};
  const checks = {
    ids_grounded: ungroundedIds.length === 0,
    runtime_values_consistent:
      runtimeContext === undefined ||
      ((!runtimeContext.engine_url || !text.includes("https://your-")) &&
        (!runtimeContext.tenant_slug || !text.includes("your-tenant"))),
    no_placeholder_markers: !PLACEHOLDER_MARKER.test(text),
    counts_consistent: countIssues.length === 0,
    ...claimChecks,
    ...remedyChecks,
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
  if (countIssues.length > 0)
    hintParts.push(
      `fix the inconsistent counts — ${countIssues
        .slice(0, 3)
        .map((c) => c.detail)
        .join(
          "; ",
        )}. Derive counts from the items you actually list, do not pad to a claimed number`,
    );
  if (claimIssues.length > 0)
    hintParts.push(
      `the reply contradicts this turn's tool results — ${claimIssues
        .slice(0, 3)
        .map((i) => i.detail)
        .join(
          "; ",
        )}. Report exactly what the tool results say, including failures and items that were not processed`,
    );
  if (remedy.length > 0)
    hintParts.push(
      `the turn ended on a refused call whose permitted next step was not taken — call ${remedy.join(" or ")}, or ask one business question with options and a recommendation; name the concrete conflict, its owner and the next step`,
    );
  return {
    verdict: "fail",
    confidence,
    reason: `chat rubric failed: ${failedKeys.join(", ")}`,
    hint: hintParts.join("; "),
    checks,
  };
}

export async function runCritic(params: RunCriticParams): Promise<CriticVerdict> {
  const { artifact, snapshot, runtimeContext } = params;
  switch (artifact.kind) {
    case "save_workflow_draft":
      return gradeSaveWorkflowDraft(artifact.payload, snapshot);
    case "chat":
      return gradeChat(
        artifact.payload,
        snapshot,
        runtimeContext,
        params.toolResults,
        params.availableTools,
        params.readOnlyTools ?? [],
      );
  }
}

export type { CriticToolResult };
export { chatRubric, saveWorkflowDraftRubric, summarizeToolResult };
