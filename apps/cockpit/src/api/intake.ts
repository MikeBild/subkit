import { apiRequest } from "./client";
import type { components, paths } from "./schema";

export type IntakeClip = components["schemas"]["IntakeItem"];
export type IntakeClipDetail = components["schemas"]["IntakeItemDetail"];
export type IntakeEvidence = components["schemas"]["IntakeItemEvidence"];
export type IntakeSnapshot = components["schemas"]["IntakeItemSnapshot"];
export type IntakeState = IntakeClip["state"];
export type IntakeProposal = components["schemas"]["IntakeProposal"];
export type IntakeProposalTarget = components["schemas"]["IntakeProposalTarget"];
export type IntakeSkillTarget = components["schemas"]["IntakeSkillTarget"];

export interface IntakeCategory {
  category: string;
  counts?: { intake?: number };
}

const categories = "/v1/categories";
const defaultCategory = "/v1/intake/default-category";
const clips = "/v1/intake/items";
const proposals = "/v1/intake/proposals";

export function listIntakeCategories(): Promise<{ categories: IntakeCategory[] }> {
  return apiRequest(categories);
}

export function getIntakeDefaultCategory(): Promise<{ category: string }> {
  return apiRequest(defaultCategory);
}

export function setIntakeDefaultCategory(category: string): Promise<{ category: string }> {
  return apiRequest(defaultCategory, { method: "PATCH", body: JSON.stringify({ category }) });
}

export function getIntakeClip(id: string): Promise<IntakeClipDetail> {
  return apiRequest(`${clips}/${encodeURIComponent(id)}`);
}

export type IntakeOriginFilter = NonNullable<
  NonNullable<paths["/v1/intake/items"]["get"]["parameters"]["query"]>["origin"]
>;
export type CreateIntakeClipInput = components["schemas"]["CreateIntakeItemBody"];

export function listIntakeClips(
  input: { category?: string; state?: IntakeState; origin?: IntakeOriginFilter } = {},
): Promise<{ items: IntakeClip[] }> {
  const params = new URLSearchParams();
  if (input.category) params.set("category", input.category);
  if (input.state) params.set("state", input.state);
  if (input.origin) params.set("origin", input.origin);
  const query = params.toString();
  return apiRequest(`${clips}${query ? `?${query}` : ""}`);
}

export function createIntakeClip(input: CreateIntakeClipInput): Promise<IntakeClip> {
  return apiRequest(clips, { method: "POST", body: JSON.stringify(input) });
}

export function updateIntakeClip(
  id: string,
  input: {
    expected_version: number;
    category?: string;
    title?: string;
    body?: string;
    note?: string;
  },
): Promise<IntakeClip> {
  return apiRequest(`${clips}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setIntakeClipState(
  id: string,
  input: { state: "discarded" | "collected"; expected_version: number },
): Promise<IntakeClip> {
  return apiRequest(`${clips}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function listIntakeProposals(): Promise<{ items: IntakeProposal[] }> {
  return apiRequest(proposals);
}

export function confirmIntakeProposal(
  id: string,
  input: { expected_revision: number; digest: string },
): Promise<IntakeProposal> {
  return apiRequest(`${proposals}/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function rejectIntakeProposal(
  id: string,
  input: { expected_revision: number },
): Promise<IntakeProposal> {
  return apiRequest(`${proposals}/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
