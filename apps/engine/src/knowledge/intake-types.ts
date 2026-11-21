import type { Actor } from "../audit/actor.ts";
import type {
  IntakeAttachmentFacts,
  IntakeCaptureSnapshot,
  IntakeProposalTarget,
  IntakeSnapshot,
  IntakeTargetKind,
} from "../db/schema/intake.ts";

export type IntakeItemOriginFilter = "capture" | "note" | "session";

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
  admitted_target_kind: IntakeTargetKind | null;
  admitted_target_id: string | null;
  attachment: IntakeAttachmentFacts | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeProposalItemView {
  id: string;
  version: number;
  title: string;
  source_url: string | null;
  source_author?: string | null;
  published_at?: string | null;
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
  confirmed_target_kind: IntakeTargetKind | null;
  confirmed_target_id: string | null;
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
  source_url?: string | undefined;
  source_author?: string | undefined;
  published_at?: string | undefined;
  captured_at: string;
  body: string;
  note?: string | undefined;
  attachment?: IntakeAttachmentFacts | undefined;
  original_snapshot?:
    | {
        title?: string | undefined;
        source_url?: string | undefined;
        source_author?: string | undefined;
        published_at?: string | undefined;
        captured_at?: string | undefined;
        body?: string | undefined;
        origin?: IntakeCaptureSnapshot["origin"] | undefined;
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

export interface DeleteIntakeItemParams {
  tenant_id: string;
  actor: Actor;
  id: string;
  expected_version: number;
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

export interface IntakeConfirmPermission {
  permission: "knowledge:write" | "skill:write" | "skill:activate" | "skill:archive";
  resource?: { type: "knowledge_source" | "skill"; id: string } | undefined;
}

export interface ConfirmIntakeProposalParams {
  tenant_id: string;
  actor: Actor;
  id: string;
  expected_revision: number;
  digest: string;
  authorize: (
    requirements: readonly IntakeConfirmPermission[],
    target: IntakeProposalTarget,
  ) => Promise<void>;
}

export interface IntakeSessionProvenance {
  agent: string;
  client?: string | undefined;
  session_id: string;
  repo?: string | null | undefined;
  domains: readonly string[];
  evidence_excerpt: string;
}

export interface SessionLearningContext {
  kind?: "practice" | "fact" | undefined;
  scope?: "global" | "connector" | "workflow" | undefined;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
  tags?: readonly string[] | undefined;
}

export interface CreateSessionIntakeItemParams {
  tenant_id: string;
  actor: Actor | null;
  session: IntakeSessionProvenance;
  title: string;
  body: string;
  captured_at: string;
  source_url?: string | undefined;
  learning?: SessionLearningContext | undefined;
  request_source?: string | undefined;
}

export interface SessionIntakeItemResult {
  item: IntakeItemView;
  outcome: "created" | "evidence_appended" | "replayed";
}

export interface IntakeItemEvidenceView {
  id: string;
  item_id: string;
  agent: string;
  session_id: string;
  repo: string | null;
  excerpt: string;
  captured_at: string;
  recorded_by: Actor;
  created_at: string;
}

export interface IntakeItemEvidenceRead {
  evidence: IntakeItemEvidenceView[];
  evidence_total: number;
}
