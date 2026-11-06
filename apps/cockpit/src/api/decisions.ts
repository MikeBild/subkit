import type { components, paths } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";
import { ApiError } from "./client";

export type PatchCandidate = components["schemas"]["PatchCandidate"];
type PatchCandidateList = components["schemas"]["PatchCandidateListResponse"];
export type PatchCandidatePreview = components["schemas"]["PatchCandidatePreview"];
export type PatchCandidateDryRun = components["schemas"]["PatchCandidateDryRunResponse"];
export type SkillCandidate = components["schemas"]["SkillCandidate"];
type SkillCandidateList = components["schemas"]["SkillCandidateListResponse"];
export type SkillCandidateEvidence = components["schemas"]["SkillCandidateEvidence"];
export type SkillCandidateApproval = components["schemas"]["SkillCandidateApprovalResult"];
type SkillCandidateApprovals = components["schemas"]["ApproveSkillCandidatesResponse"];
type SkillCandidateApprovalResponse = components["schemas"]["ApproveSkillCandidateResponse"];

const QUEUE_LIMIT = 200;

async function allDecisionPages<T>(
  page: (offset: number) => Promise<{ items: T[]; total: number; reviewable_total: number }>,
): Promise<{ items: T[]; total: number; reviewable_total: number }> {
  const first = await page(0);
  const items = [...first.items];
  while (items.length < first.total) {
    const next = await page(items.length);
    if (!next.items.length) break;
    items.push(...next.items);
  }
  return { ...first, items };
}

function pageWindow(offset: number): { limit: number; offset?: number } {
  return offset ? { limit: QUEUE_LIMIT, offset } : { limit: QUEUE_LIMIT };
}

export function listProposedPatchCandidates(workflowId?: string): Promise<PatchCandidateList> {
  return allDecisionPages((offset) =>
    apiCall("get", "/v1/patch-candidates", {
      query: {
        status: "proposed",
        order: "asc",
        ...(workflowId ? { workflow_id: workflowId } : {}),
        ...pageWindow(offset),
      },
    }),
  );
}

export function listProposedSkillCandidates(): Promise<SkillCandidateList> {
  return allDecisionPages((offset) =>
    apiCall("get", "/v1/skill-candidates", {
      query: { status: "proposed", ...pageWindow(offset) },
    }),
  );
}

export function listWorkflowContextNotes(workflowId: string): Promise<SkillCandidateList> {
  return apiCall("get", "/v1/skill-candidates", {
    query: { status: "context", workflow_id: workflowId, limit: 50 },
  });
}

export function getPatchCandidatePreview(id: string): Promise<PatchCandidatePreview> {
  return apiCall("get", "/v1/patch-candidates/{id}/preview", { path: { id } });
}

export function dryRunPatchCandidate(id: string): Promise<PatchCandidateDryRun> {
  return apiCall("post", "/v1/patch-candidates/{id}/dry-run", { path: { id } });
}

export async function approvePatchCandidate(
  id: string,
  expected_review_digest: string,
): Promise<{ applied: boolean; workflow_version_id: string | null }> {
  const result = await apiCall("post", "/v1/patch-candidates/{id}/approve", {
    path: { id },
    body: { expected_review_digest },
  });
  if (!result.applied || !result.workflow_version_id)
    throw new ApiError(409, { code: "patch_not_applicable" }, null);
  return result;
}

export function rejectPatchCandidate(id: string, reason: string): Promise<{ rejected: boolean }> {
  return apiCall("post", "/v1/patch-candidates/{id}/reject", {
    path: { id },
    body: reason ? { reason } : {},
  });
}

export function approveSkillCandidate(
  id: string,
  expected_review_digest: string,
): Promise<SkillCandidateApprovalResponse> {
  return apiCall("post", "/v1/skill-candidates/{id}/approve", {
    path: { id },
    body: { status: "active", expected_review_digest },
  });
}

export function approveSkillCandidates(
  candidates: readonly { id: string; expected_review_digest: string }[],
): Promise<SkillCandidateApprovals> {
  return apiCall("post", "/v1/skill-candidates/approve", {
    body: { candidates: [...candidates] },
  });
}

export function getSkillCandidate(id: string): Promise<SkillCandidate> {
  return apiCall("get", "/v1/skill-candidates/{id}", { path: { id } });
}

export function rejectSkillCandidate(id: string, reason: string): Promise<{ rejected: boolean }> {
  return apiCall("post", "/v1/skill-candidates/{id}/reject", {
    path: { id },
    body: reason ? { reason } : {},
  });
}

export function listSkillCandidateEvidence(
  id: string,
): Promise<{ items: SkillCandidateEvidence[] }> {
  return apiCall("get", "/v1/skill-candidates/{id}/evidence", { path: { id } });
}

export type HeldSchedule = components["schemas"]["ScheduleEntry"];
export type InboundHookAutomation =
  paths["/v1/workflows/{id}/automation-status"]["get"]["responses"][200]["content"]["application/json"]["inbound_hooks"][number];

export async function listHeldInboundHooks(workflowId: string): Promise<InboundHookAutomation[]> {
  const result = await apiCall("get", "/v1/workflows/{id}/automation-status", {
    path: { id: workflowId },
  });
  return result.inbound_hooks.filter((hook) => hook.admission_hold);
}
export async function listHeldSchedules(): Promise<HeldSchedule[]> {
  const result = await apiCall("get", "/v1/schedules", {});
  return result.schedules.filter((schedule) => !schedule.paused && schedule.admission_hold);
}
