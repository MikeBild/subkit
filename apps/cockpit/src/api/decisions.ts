import { apiRequest } from "./client";
import type { components } from "./schema";

export type PatchCandidate = components["schemas"]["PatchCandidate"];
export type PatchCandidateList = components["schemas"]["PatchCandidateListResponse"];
export type PatchCandidatePreview = components["schemas"]["PatchCandidatePreview"];
export type PatchCandidateDryRun = components["schemas"]["PatchCandidateDryRunResponse"];
export type SkillCandidate = components["schemas"]["SkillCandidate"];
export type SkillCandidateList = components["schemas"]["SkillCandidateListResponse"];
export type SkillCandidateEvidence = components["schemas"]["SkillCandidateEvidence"];
export type ConversationList = components["schemas"]["ConversationListResponse"];

const QUEUE_LIMIT = 200;

// Oldest first: the queue must never hide the position that has waited longest,
// and the page cap would otherwise drop exactly those rows.
export function listProposedPatchCandidates(): Promise<PatchCandidateList> {
  return apiRequest(`/v1/patch-candidates?status=proposed&order=asc&limit=${QUEUE_LIMIT}`);
}

export function listPatchCandidatesByStatus(
  status: "applied" | "rejected",
): Promise<PatchCandidateList> {
  return apiRequest(`/v1/patch-candidates?status=${status}&order=desc&limit=25`);
}

export function listProposedSkillCandidates(): Promise<SkillCandidateList> {
  return apiRequest(`/v1/skill-candidates?status=proposed&limit=${QUEUE_LIMIT}`);
}

export function listSkillCandidatesByStatus(
  status: "approved" | "rejected",
): Promise<SkillCandidateList> {
  return apiRequest(`/v1/skill-candidates?status=${status}&limit=25`);
}

export function listAwaitingConversations(): Promise<ConversationList> {
  return apiRequest(
    `/v1/conversations?status=awaiting_input&sort=updated_at&order=asc&limit=${QUEUE_LIMIT}`,
  );
}

export function getPatchCandidatePreview(id: string): Promise<PatchCandidatePreview> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/preview`);
}

export function dryRunPatchCandidate(id: string): Promise<PatchCandidateDryRun> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/dry-run`, { method: "POST" });
}

export function approvePatchCandidate(
  id: string,
): Promise<{ applied: boolean; workflow_version_id: string | null }> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

export function rejectPatchCandidate(id: string, reason: string): Promise<{ rejected: boolean }> {
  return apiRequest(`/v1/patch-candidates/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function approveSkillCandidate(id: string): Promise<unknown> {
  return apiRequest(`/v1/skill-candidates/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
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
