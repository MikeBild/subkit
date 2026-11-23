import { z } from "zod";
import { apiCall, resolveApiPath } from "@/api/call";
import { ApiError } from "@/api/client";
import { apiRequest } from "@/api/transport";
import { fetchCurrentVersionDag } from "@/features/admin";
import {
  applyAccepted,
  type ChangeTestResult,
  type StepOperation,
  stepOperations,
  withPatchedStep,
} from "../model/change-review";
import { workflowPreviewDefinition, workflowPreviewRequest } from "../model/workflow-preview";

export const PatchOperationSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  path: z.string(),
  description_key: z.string().optional(),
});
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const PatchCandidateReviewExtensionSchema = z.looseObject({
  operations: z.array(PatchOperationSchema).optional(),
  accepted_operations: z.array(z.number().int().nonnegative()).nullable().optional(),
  accepted_digest: z.string().nullable().optional(),
});

export const DryRunAcceptedBodySchema = z.object({
  accepted_operations: z.array(z.number().int().nonnegative()).optional(),
});

export const DryRunAcceptedResponseSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().nullable(),
  review_digest: z.string().nullable().optional(),
});

export const ApproveAcceptedBodySchema = z.object({
  expected_review_digest: z.string(),
  accepted_operations: z.array(z.number().int().nonnegative()).optional(),
});

export const ApproveAcceptedResponseSchema = z.looseObject({
  applied: z.boolean(),
  workflow_version_id: z.string().nullable(),
});

export function listedOperationPaths(preview: unknown): string[] | null {
  const parsed = PatchCandidateReviewExtensionSchema.safeParse(preview);
  const operations = parsed.success ? parsed.data.operations : undefined;
  if (!operations?.length) return null;
  return [...operations].sort((a, b) => a.index - b.index).map((operation) => operation.path);
}

export function candidateReviewOperations(preview: {
  before_step: unknown;
  after_step: unknown;
  changed_paths?: readonly string[] | null;
}): StepOperation[] {
  return stepOperations(
    preview.before_step,
    preview.after_step,
    listedOperationPaths(preview) ?? preview.changed_paths,
  );
}

function post<T>(template: string, id: string, body: unknown): Promise<T> {
  return apiRequest<T>(
    resolveApiPath(template, { id }, undefined),
    { method: "POST", body: JSON.stringify(body) },
    {},
  );
}

export async function dryRunAcceptedOperations(
  id: string,
  accepted: readonly number[] | undefined,
): Promise<ChangeTestResult> {
  const body = DryRunAcceptedBodySchema.parse(accepted ? { accepted_operations: accepted } : {});
  const result = DryRunAcceptedResponseSchema.parse(
    await post<unknown>("/v1/patch-candidates/{id}/dry-run", id, body),
  );
  return {
    ok: result.ok,
    error: result.error,
    digest: result.ok ? (result.review_digest ?? null) : null,
  };
}

export async function approveAcceptedOperations(
  id: string,
  expected_review_digest: string,
  accepted: readonly number[] | undefined,
): Promise<{ applied: boolean; workflow_version_id: string | null }> {
  const body = ApproveAcceptedBodySchema.parse({
    expected_review_digest,
    ...(accepted ? { accepted_operations: accepted } : {}),
  });
  const result = ApproveAcceptedResponseSchema.parse(
    await post<unknown>("/v1/patch-candidates/{id}/approve", id, body),
  );
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
