import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type IntakeClip = components["schemas"]["IntakeItem"];
type IntakeClipDetail = components["schemas"]["IntakeItemDetail"];
export type IntakeSnapshot = components["schemas"]["IntakeItemSnapshot"];
export type IntakeState = IntakeClip["state"];
export type IntakeProposal = components["schemas"]["IntakeProposal"];
export type IntakeProposalTarget = components["schemas"]["IntakeProposalTargetOutput"];
export type IntakeSkillTarget = components["schemas"]["IntakeSkillTargetOutput"];
type CategoryList = components["schemas"]["CategoryListResponse"];
type DefaultCategoryCheck = components["schemas"]["IntakeDefaultCategoryCheck"];
type DefaultCategory = components["schemas"]["IntakeDefaultCategory"];
type IntakeClipPatch = components["schemas"]["PatchIntakeItemBody"];

export function listIntakeCategories(): Promise<CategoryList> {
  return apiCall("get", "/v1/categories", {});
}

export function getIntakeDefaultCategory(): Promise<DefaultCategoryCheck> {
  return apiCall("get", "/v1/intake/default-category", {});
}

export function setIntakeDefaultCategory(category: string): Promise<DefaultCategory> {
  return apiCall("patch", "/v1/intake/default-category", { body: { category } });
}

export function getIntakeClip(id: string): Promise<IntakeClipDetail> {
  return apiCall("get", "/v1/intake/items/{id}", { path: { id } });
}

export type CreateIntakeClipInput = components["schemas"]["CreateIntakeItemBody"];

export function listIntakeClips(
  input: { category?: string; state?: IntakeState } = {},
): Promise<{ items: IntakeClip[] }> {
  return apiCall("get", "/v1/intake/items", {
    query: {
      ...(input.category ? { category: input.category } : {}),
      ...(input.state ? { state: input.state } : {}),
    },
  });
}

export function createIntakeClip(input: CreateIntakeClipInput): Promise<IntakeClip> {
  return apiCall("post", "/v1/intake/items", { body: input });
}

export function updateIntakeClip(
  id: string,
  input: Omit<IntakeClipPatch, "state">,
): Promise<IntakeClip> {
  return apiCall("patch", "/v1/intake/items/{id}", { path: { id }, body: input });
}

export function setIntakeClipState(
  id: string,
  input: { state: "discarded" | "collected"; expected_version: number },
): Promise<IntakeClip> {
  return apiCall("patch", "/v1/intake/items/{id}", { path: { id }, body: input });
}

export async function deleteDiscardedIntakeClip(
  id: string,
  expectedVersion: number,
): Promise<void> {
  await apiCall("delete", "/v1/intake/items/{id}", {
    path: { id },
    body: { expected_version: expectedVersion },
  });
}

export function listIntakeProposals(): Promise<{ items: IntakeProposal[] }> {
  return apiCall("get", "/v1/intake/proposals", {});
}

export function confirmIntakeProposal(
  id: string,
  input: { expected_revision: number; digest: string },
): Promise<IntakeProposal> {
  return apiCall("post", "/v1/intake/proposals/{id}/confirm", { path: { id }, body: input });
}

export function rejectIntakeProposal(
  id: string,
  input: { expected_revision: number },
): Promise<IntakeProposal> {
  return apiCall("post", "/v1/intake/proposals/{id}/reject", { path: { id }, body: input });
}
