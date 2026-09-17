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

/**
 * Post-start guidance: what the author must do next to make a freshly
 * started connector draft usable, keyed on auth_type. Lives here (not
 * inline in each start_* tool) so `start_connector_from_description` and
 * `start_connector_from_template` steer the LLM IDENTICALLY. Pre-fix the
 * template path returned no `next_phase`, so for oauth2 connectors the
 * LLM improvised "ask the user for an API access token" — wrong for
 * providers like LinkedIn that only issue tokens through the
 * authorization-code flow (confirmed in a live session: ask_user_form
 * summary "Enter your LinkedIn API access token" on an oauth2 draft).
 */
export function buildAuthNextPhase(authType: string | undefined): {
  phase: string;
  next_suggested_tool: string;
  hint: string;
} {
  if (authType === "oauth2") {
    return {
      phase: "authenticate_connector",
      next_suggested_tool: "authenticate_oauth",
      hint:
        "OAuth2 connector — do NOT ask the user for an access token or API key. " +
        "First collect the operator's OAuth2 client_id and client_secret " +
        "(client_secret as a sensitive field) via ask_user_form; save_connector_draft " +
        "binds them atomically; then call authenticate_oauth to run the " +
        "authorization-code flow. The saved template_snapshot already carries the " +
        "authorization/token endpoints and scopes — no manual oauth config needed.",
    };
  }
  if (authType === "none") {
    return {
      phase: "test_connector",
      next_suggested_tool: "probe_connector_draft",
      hint: "No credential needed. Probe the draft to verify base_url, then save.",
    };
  }
  return {
    phase: "authenticate_connector",
    next_suggested_tool: "ask_user_form",
    hint: `Collect the operator's credential for auth_type=${authType} (token / api key / username+password) via ask_user_form, then save_connector_draft binds it atomically with the connector.`,
  };
}

/** Keep lifecycle evidence, not duplicated response bodies, in every mutation/error. */
function compactSummary(
  summary: ReturnType<typeof getAuthoringSnapshot>["summary"],
): ReturnType<typeof getAuthoringSnapshot>["summary"] {
  if (!summary?.latest_diagnosis) return summary;
  return {
    ...summary,
    latest_diagnosis: {
      ...summary.latest_diagnosis,
      steps: summary.latest_diagnosis.steps.map(({ output_preview, request_meta, ...step }) => {
        void output_preview;
        void request_meta;
        return step;
      }),
    },
  };
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
    summary: compactSummary(snapshot.summary),
    persistence: "draft_only" as const,
    ...(args.extra ?? {}),
  };
}

/**
 * Slim down `summary` for read-only tool results (`dry_run_workflow`,
 * `inspect_workflow_draft`, etc.). Pre-fix every preview echoed the full
 * checkpoint array + persisted_resources + latest_execution + latest_
 * diagnosis on every call — accumulating ~1.5 KB per tool result. In a
 * session that loops on a JSONata transform that's 10–20 calls of pure
 * envelope cost per turn. The author only needs `next_required_action`,
 * `blocked_by`, `active_target`, and `last_action` to decide what to do
 * next. The heavier sub-fields stay on *mutation* paths
 * (`update_param`, `save_workflow_draft`) where the author actually
 * needs to know which resources persisted and what's verified.
 */
function slimSummaryForReadOnly(
  summary: ReturnType<typeof getAuthoringSnapshot>["summary"],
): ReturnType<typeof getAuthoringSnapshot>["summary"] {
  if (!summary) return summary;
  const asRecord = summary as unknown as Record<string, unknown>;
  const { checkpoints, persisted_resources, latest_execution, latest_diagnosis, ...rest } =
    asRecord;
  // Reference the dropped fields so the linter does not flag them.
  void checkpoints;
  void persisted_resources;
  void latest_execution;
  void latest_diagnosis;
  return rest as unknown as ReturnType<typeof getAuthoringSnapshot>["summary"];
}

export interface BuildLifecyclePayloadOptions {
  /** When true, omit `checkpoints[]`, `persisted_resources[]`,
   *  `latest_execution`, and `latest_diagnosis` from `summary` —
   *  appropriate for read-only tool results where these fields just
   *  inflate token cost without driving the next decision. */
  readOnly?: boolean;
}

export function buildLifecyclePayload(
  draft: DraftDocument,
  extra?: Record<string, unknown>,
  options?: BuildLifecyclePayloadOptions,
): Record<string, unknown> {
  const snapshot = getAuthoringSnapshot(draft);
  const activeTarget = snapshot.summary?.active_target ?? null;
  const persistedVersion =
    activeTarget?.kind === "connector" || activeTarget?.kind === "workflow"
      ? (snapshot.summary?.persisted_resources.find(
          (item) => item.kind === activeTarget.kind && item.id === activeTarget.id,
        ) ?? null)
      : null;
  const summary = options?.readOnly
    ? slimSummaryForReadOnly(snapshot.summary)
    : compactSummary(snapshot.summary);
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
    summary,
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
    persistence: "saved" as const,
    target_ref: snapshot.summary?.active_target ?? null,
    stale_after_mutation: false,
    next_required_action: snapshot.summary?.next_required_action ?? null,
    blocking_reasons: snapshot.summary?.blocked_by ?? [],
  };
}
