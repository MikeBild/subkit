import { apiRequest } from "./client";

export type IntakeState = "collected" | "reviewing" | "admitted" | "discarded";

export interface IntakeCategory {
  category: string;
}

export interface IntakeClip {
  id: string;
  category: string;
  title: string;
  body: string;
  note: string;
  original_snapshot: {
    title: string;
    source_url: string;
    source_author?: string;
    published_at?: string;
    captured_at: string;
    body: string;
    origin: string;
  };
  state: IntakeState;
  version: number;
  admitted_knowledge_source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeProposalSource {
  id: string;
  version: number;
  title: string;
  source_url: string;
}

export interface IntakeProposal {
  id: string;
  status: "draft" | "stale" | "confirmed" | "rejected";
  current_revision: number;
  confirmed_revision: number | null;
  confirmed_knowledge_source_id: string | null;
  rejected_at: string | null;
  stale_reason: string | null;
  revision: {
    revision: number;
    digest: string;
    title: string;
    body: string;
    target:
      | { knowledge_source_id: string; expected_version: string }
      | { name: string; category?: string; tags?: string[] };
    items: IntakeProposalSource[];
    created_at: string;
  };
  created_at: string;
  updated_at: string;
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

export function getIntakeClip(id: string): Promise<IntakeClip> {
  return apiRequest(`${clips}/${encodeURIComponent(id)}`);
}

export function listIntakeClips(
  input: { category?: string; state?: IntakeState } = {},
): Promise<{ items: IntakeClip[] }> {
  const params = new URLSearchParams();
  if (input.category) params.set("category", input.category);
  if (input.state) params.set("state", input.state);
  const query = params.toString();
  return apiRequest(`${clips}${query ? `?${query}` : ""}`);
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
