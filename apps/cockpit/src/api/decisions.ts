import { ApiError, apiRequest } from "./client";
import type { components } from "./schema";

export type PatchCandidate = components["schemas"]["PatchCandidate"];
export type PatchCandidateList = components["schemas"]["PatchCandidateListResponse"];
export type PatchCandidatePreview = components["schemas"]["PatchCandidatePreview"];
export type PatchCandidateDryRun = components["schemas"]["PatchCandidateDryRunResponse"];
export type SkillCandidate = components["schemas"]["SkillCandidate"];
export type SkillCandidateList = components["schemas"]["SkillCandidateListResponse"];
export type SkillCandidateEvidence = components["schemas"]["SkillCandidateEvidence"];

const QUEUE_LIMIT = 200;

// Oldest first: the queue must never hide the position that has waited longest,
// and the page cap would otherwise drop exactly those rows.
async function allDecisionPages<T>(
  path: string,
): Promise<{ items: T[]; total: number; reviewable_total: number }> {
  const first = await apiRequest<{ items: T[]; total: number; reviewable_total: number }>(
    `${path}&limit=${QUEUE_LIMIT}`,
  );
  const items = [...first.items];
  while (items.length < first.total) {
    const page = await apiRequest<{ items: T[] }>(
      `${path}&limit=${QUEUE_LIMIT}&offset=${items.length}`,
    );
    if (!page.items.length) break;
    items.push(...page.items);
  }
  return { ...first, items };
}

/** Proposed fixes, oldest first — all of them, or one workflow's. */
export function listProposedPatchCandidates(workflowId?: string): Promise<PatchCandidateList> {
  const scope = workflowId ? `&workflow_id=${encodeURIComponent(workflowId)}` : "";
  return allDecisionPages<PatchCandidate>(`/v1/patch-candidates?status=proposed&order=asc${scope}`);
}

export function listPatchCandidatesByStatus(
  status: "applied" | "rejected",
): Promise<PatchCandidateList> {
  return apiRequest(`/v1/patch-candidates?status=${status}&order=desc&limit=25`);
}

export function listProposedSkillCandidates(): Promise<SkillCandidateList> {
  return allDecisionPages<SkillCandidate>("/v1/skill-candidates?status=proposed");
}

export function listSkillCandidatesByStatus(
  status: "approved" | "rejected",
): Promise<SkillCandidateList> {
  return apiRequest(`/v1/skill-candidates?status=${status}&limit=25`);
}

export function getPatchCandidatePreview(id: string): Promise<PatchCandidatePreview> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/preview`);
}

export function dryRunPatchCandidate(id: string): Promise<PatchCandidateDryRun> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/dry-run`, { method: "POST" });
}

export function approvePatchCandidate(
  id: string,
  expected_review_digest: string,
): Promise<{ applied: boolean; workflow_version_id: string | null }> {
  return apiRequest<{ applied: boolean; workflow_version_id: string | null }>(
    `/v1/patch-candidates/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({ expected_review_digest }) },
  ).then((result) => {
    if (!result.applied || !result.workflow_version_id)
      throw new ApiError(409, { code: "patch_not_applicable" }, null);
    return result;
  });
}

export function rejectPatchCandidate(id: string, reason: string): Promise<{ rejected: boolean }> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function approveSkillCandidate(
  id: string,
  expected_review_digest: string,
): Promise<unknown> {
  return apiRequest(`/v1/skill-candidates/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ status: "active", expected_review_digest }),
  });
}

export function rejectSkillCandidate(id: string, reason: string): Promise<unknown> {
  return apiRequest(`/v1/skill-candidates/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

/**
 * The observed cases a proposed skill was distilled from.
 *
 * Fetched only when a card is expanded: the list already carries the count, and
 * one request per open card is one request — there is never more than one open.
 */
export function listSkillCandidateEvidence(
  id: string,
): Promise<{ items: SkillCandidateEvidence[] }> {
  return apiRequest(`/v1/skill-candidates/${encodeURIComponent(id)}/evidence`);
}

/**
 * How far back this queue asks. It has to be the engine's
 * `DECISION_FAILURE_WINDOW_HOURS`, because the overview counts the same thing
 * over that span — when the two drifted apart, the overview said "production
 * incidents: 0" beside a badge counting two of them, and nothing on either
 * screen explained the difference. `decision-window.test.ts` holds them equal.
 */
export type HeldSchedule = components["schemas"]["ScheduleEntry"];
export async function listHeldSchedules(): Promise<HeldSchedule[]> {
  const result = await apiRequest<{ schedules: HeldSchedule[] }>("/v1/schedules");
  return result.schedules.filter((schedule) => !schedule.paused && schedule.admission_hold);
}
