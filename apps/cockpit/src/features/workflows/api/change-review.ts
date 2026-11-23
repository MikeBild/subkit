import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { fetchCurrentVersionDag } from "@/features/admin";
import {
  applyAccepted,
  type ChangeTestResult,
  type StepOperation,
  stepOperations,
  withPatchedStep,
} from "../model/change-review";
import { workflowPreviewDefinition, workflowPreviewRequest } from "../model/workflow-preview";

type PatchCandidatePreview = components["schemas"]["PatchCandidatePreview"];

export function listedOperationPaths(
  operations: PatchCandidatePreview["operations"] | undefined,
): string[] | null {
  if (!operations?.length) return null;
  return [...operations].sort((a, b) => a.index - b.index).map((operation) => operation.path);
}

export function candidateReviewOperations(
  preview: Pick<PatchCandidatePreview, "before_step" | "after_step" | "changed_paths"> & {
    operations?: PatchCandidatePreview["operations"];
  },
): StepOperation[] {
  return stepOperations(
    preview.before_step,
    preview.after_step,
    listedOperationPaths(preview.operations) ?? preview.changed_paths,
  );
}

export async function dryRunAcceptedOperations(
  id: string,
  accepted: readonly number[] | undefined,
): Promise<ChangeTestResult> {
  const result = await apiCall("post", "/v1/patch-candidates/{id}/dry-run", {
    path: { id },
    body: accepted ? { accepted_operations: [...accepted] } : {},
  });
  return {
    ok: result.ok,
    error: result.error,
    digest: result.ok ? result.review_digest : null,
  };
}

export async function approveAcceptedOperations(
  id: string,
  expected_review_digest: string,
  accepted: readonly number[] | undefined,
): Promise<{ applied: boolean; workflow_version_id: string }> {
  const result = await apiCall("post", "/v1/patch-candidates/{id}/approve", {
    path: { id },
    body: { expected_review_digest, ...(accepted ? { accepted_operations: [...accepted] } : {}) },
  });
  if (!result.applied || !result.workflow_version_id)
    throw new ApiError(409, { code: "patch_not_applicable" }, null);
  return { applied: result.applied, workflow_version_id: result.workflow_version_id };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureText(error: unknown): string | null {
  const message = record(error)?.message ?? error;
  return typeof message === "string" && message ? message : null;
}

export async function runPatchedDraft(input: {
  workflowId: string;
  baseVersionId: string | null;
  stepId: string;
  before: unknown;
  operations: readonly StepOperation[];
  accepted: readonly number[];
}): Promise<ChangeTestResult | null> {
  const dag = record(
    await fetchCurrentVersionDag(
      (limit, offset) =>
        apiCall("get", "/v1/workflows/{id}/history", {
          path: { id: input.workflowId },
          query: { limit, offset },
        }),
      input.baseVersionId,
      null,
    ),
  );
  const steps = dag && Array.isArray(dag.steps) ? dag.steps : null;
  if (!dag || !steps) return null;
  const patched = withPatchedStep(
    steps,
    input.stepId,
    applyAccepted(input.before, input.operations, input.accepted),
  );
  if (!patched) return null;
  const run = await apiCall("post", "/v1/executions", {
    body: workflowPreviewRequest({
      source: "draft",
      definition: workflowPreviewDefinition(dag, patched as Record<string, unknown>[]),
    }),
  });
  const ok = run.status === "succeeded";
  return { ok, error: ok ? null : failureText(run.error), digest: null };
}

export async function testCandidateChange(input: {
  candidateId: string;
  workflowId: string;
  baseVersionId: string | null;
  stepId: string | null;
  before: unknown;
  operations: readonly StepOperation[];
  accepted: readonly number[];
  partial: boolean;
  fixtureAvailable: boolean;
}): Promise<ChangeTestResult> {
  const replay =
    input.partial || input.fixtureAvailable
      ? await dryRunAcceptedOperations(
          input.candidateId,
          input.partial ? input.accepted : undefined,
        )
      : null;
  if (replay && !replay.ok) return replay;
  const digest = replay?.digest ?? null;
  const draft = input.stepId
    ? await runPatchedDraft({
        workflowId: input.workflowId,
        baseVersionId: input.baseVersionId,
        stepId: input.stepId,
        before: input.before,
        operations: input.operations,
        accepted: input.accepted,
      }).catch((error: unknown) => ({ ok: false, error: failureText(error), digest: null }))
    : null;
  if (draft && !draft.ok) return { ...draft, digest };
  return { ok: Boolean(replay || draft), error: null, digest };
}
