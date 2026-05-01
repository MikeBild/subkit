import { normalizeDraftDocument } from "../authoring-state.ts";
import type { AuthoringCheckpointKey, AuthoringCheckpointView, DraftDocument } from "../types.ts";

type ResourceKind = "connector" | "workflow";

function checkpointToolName(key: AuthoringCheckpointKey): string {
  switch (key) {
    case "connector_inspected":
      return "inspect_connector_draft";
    case "connector_validated":
      return "validate_connector_draft";
    case "connector_authenticated":
      // The actual next-best tool depends on auth_type at runtime —
      // use ask_user_form as the default surface; oauth2 paths get
      // steered to authenticate_oauth via blocked_by directly in
      // computeBlockedBy. The label here is just for stale lookups.
      return "ask_user_form";
    case "connector_probed":
      return "probe_connector_draft";
    case "connector_persisted":
      return "save_connector_draft";
    case "workflow_inspected":
      return "inspect_workflow_draft";
    case "workflow_validated":
      return "validate_draft";
    case "workflow_previewed":
      return "dry_run_workflow";
    case "workflow_persisted":
      return "save_workflow_draft";
    case "workflow_executed":
      return "run_workflow";
    case "workflow_diagnosed":
      return "diagnose_latest_execution";
  }
}

function checkpointStatusByKey(
  checkpoints: AuthoringCheckpointView[] | undefined,
  key: AuthoringCheckpointKey,
): AuthoringCheckpointView["status"] {
  return checkpoints?.find((checkpoint) => checkpoint.key === key)?.status ?? "missing";
}

export function getAuthoringSnapshot(draft: DraftDocument) {
  const normalized = normalizeDraftDocument(draft);
  const summary = normalized.summary ?? null;
  return {
    draft: normalized,
    summary,
    state: normalized.state ?? null,
    mode: summary?.mode ?? "connector",
    stage: summary?.stage ?? "idle",
    lifecycle_state: summary?.lifecycle_state ?? "none",
  };
}

export function missingFreshCheckpoints(
  draft: DraftDocument,
  keys: AuthoringCheckpointKey[],
): AuthoringCheckpointKey[] {
  const { summary } = getAuthoringSnapshot(draft);
  return keys.filter((key) => checkpointStatusByKey(summary?.checkpoints, key) !== "fresh");
}

export function toNextBestActions(
  stale_checkpoints: AuthoringCheckpointKey[],
  blocking_reasons: string[],
): string[] {
  const actions = [
    ...stale_checkpoints.map(checkpointToolName),
    ...blocking_reasons.filter((reason) => !reason.startsWith("missing:")),
  ];
  return [...new Set(actions)];
}

export function buildGateError(
  draft: DraftDocument,
  args: {
    error_code: string;
    message: string;
    blocking_reasons?: string[];
    stale_checkpoints?: AuthoringCheckpointKey[];
    next_best_actions?: string[];
    recommended_mode?: "connector" | "workflow" | "execution" | "diagnosis";
    requires_user_input?: boolean;
    extra?: Record<string, unknown>;
  },
) {
  const snapshot = getAuthoringSnapshot(draft);
  const blocking_reasons = args.blocking_reasons ?? snapshot.summary?.blocked_by ?? [];
  const stale_checkpoints = args.stale_checkpoints ?? [];
  return {
    error: args.error_code,
    error_code: args.error_code,
    message: args.message,
    recoverable: true,
    requires_user_input: args.requires_user_input ?? false,
    recommended_mode: args.recommended_mode ?? snapshot.mode,
    next_best_actions:
      args.next_best_actions ?? toNextBestActions(stale_checkpoints, blocking_reasons),
    stale_checkpoints,
    blocking_reasons,
    mode: snapshot.mode,
    stage: snapshot.stage,
    lifecycle_state: snapshot.lifecycle_state,
    summary: snapshot.summary,
    ...(args.extra ?? {}),
  };
}

export function buildLifecyclePayload(
  draft: DraftDocument,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = getAuthoringSnapshot(draft);
  const activeTarget = snapshot.summary?.active_target ?? null;
  const persistedVersion =
    activeTarget?.kind === "connector" || activeTarget?.kind === "workflow"
      ? (snapshot.summary?.persisted_resources.find(
          (item) => item.kind === activeTarget.kind && item.id === activeTarget.id,
        ) ?? null)
      : null;
  return {
    mode: snapshot.mode,
    stage: snapshot.stage,
    lifecycle_state: snapshot.lifecycle_state,
    resource_kind:
      activeTarget?.kind === "connector" || activeTarget?.kind === "workflow"
        ? activeTarget.kind
        : null,
    resource_id: activeTarget?.id ?? null,
    version_id: persistedVersion?.version_id ?? null,
    target_ref: activeTarget,
    next_required_action: snapshot.summary?.next_required_action ?? null,
    blocking_reasons: snapshot.summary?.blocked_by ?? [],
    summary: snapshot.summary,
    ...(extra ?? {}),
  };
}

export function buildDraftMutationPayload(
  draft: DraftDocument,
  args?: {
    resource_kind?: ResourceKind;
    stale_after_mutation?: boolean;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const snapshot = getAuthoringSnapshot(draft);
  const targetKind =
    args?.resource_kind ??
    (snapshot.summary?.active_target.kind === "connector" ||
    snapshot.summary?.active_target.kind === "workflow"
      ? snapshot.summary.active_target.kind
      : null);
  const draftRevision =
    targetKind === "connector"
      ? (snapshot.state?.connector_mutation_seq ?? 0)
      : targetKind === "workflow"
        ? (snapshot.state?.workflow_mutation_seq ?? 0)
        : null;
  return {
    ...buildLifecyclePayload(draft),
    draft_revision: draftRevision,
    stale_after_mutation: args?.stale_after_mutation ?? true,
    ...(args?.extra ?? {}),
  };
}

export function buildPersistencePayload(
  draft: DraftDocument,
  args: {
    resource_kind: ResourceKind;
    resource_id: string;
    version_id?: string | null;
  },
): Record<string, unknown> {
  const snapshot = getAuthoringSnapshot(draft);
  const draft_revision =
    args.resource_kind === "connector"
      ? (snapshot.state?.connector_mutation_seq ?? 0)
      : (snapshot.state?.workflow_mutation_seq ?? 0);
  return {
    ...buildLifecyclePayload(draft),
    resource_kind: args.resource_kind,
    resource_id: args.resource_id,
    version_id: args.version_id ?? null,
    draft_revision,
    lifecycle_state: "persisted",
    target_ref: snapshot.summary?.active_target ?? null,
    stale_after_mutation: false,
    next_required_action: snapshot.summary?.next_required_action ?? null,
    blocking_reasons: snapshot.summary?.blocked_by ?? [],
  };
}
