import type { Actor } from "../audit/actor.ts";
import type { IntakeProposalTarget, IntakeSnapshot } from "../db/schema/intake.ts";

export type IntakeItemState = "collected" | "reviewing" | "admitted" | "discarded";
export type IntakeProposalStatus = "draft" | "stale" | "confirmed" | "rejected";

export interface IntakeCategoryView {
  category: string;
  collected: number;
  reviewing: number;
  is_default: boolean;
}

export interface IntakeItemView {
  id: string;
  tenant_id: string;
  category: string;
  client_request_id: string;
  original_snapshot: IntakeSnapshot;
  title: string;
  body: string;
  note: string;
  state: IntakeItemState;
  version: number;
  collected_by: Actor;
  admitted_knowledge_source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeProposalItemView {
  id: string;
  version: number;
  title: string;
  source_url: string;
}

export interface IntakeProposalRevisionView {
  revision: number;
  digest: string;
  title: string;
  body: string;
  target: IntakeProposalTarget;
  items: IntakeProposalItemView[];
  created_at: string;
}

export interface IntakeProposalView {
  id: string;
  tenant_id: string;
  status: IntakeProposalStatus;
  current_revision: number;
  confirmed_revision: number | null;
  confirmed_knowledge_source_id: string | null;
  rejected_at: string | null;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
  revision: IntakeProposalRevisionView;
}

export interface SetIntakeDefaultCategoryParams {
  tenant_id: string;
  actor: Actor;
  category: string;
}

export interface CreateIntakeItemParams {
  tenant_id: string;
  actor: Actor;
  client_request_id: string;
  category?: string | undefined;
  title: string;
  source_url: string;
  source_author?: string | undefined;
  published_at?: string | undefined;
  captured_at: string;
  body: string;
  note?: string | undefined;
  original_snapshot?:
    | {
        title?: string | undefined;
        source_url?: string | undefined;
        source_author?: string | undefined;
        published_at?: string | undefined;
        captured_at?: string | undefined;
        body?: string | undefined;
        origin?: IntakeSnapshot["origin"] | undefined;
      }
    | undefined;
}

export interface PatchIntakeItemParams {
  tenant_id: string;
  actor: Actor;
  id: string;
  expected_version: number;
  category?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  note?: string | undefined;
  state?: Exclude<IntakeItemState, "admitted"> | undefined;
}

export interface CreateIntakeProposalParams {
  tenant_id: string;
  actor: Actor;
  item_ids: string[];
  expected_item_versions?: Record<string, number> | undefined;
  title: string;
  body: string;
  target: IntakeProposalTarget;
}

export interface ReviseIntakeProposalParams extends CreateIntakeProposalParams {
  id: string;
  expected_revision: number;
}

export interface ConfirmIntakeProposalParams {
  tenant_id: string;
  actor: Actor;
  id: string;
  expected_revision: number;
  digest: string;
}
