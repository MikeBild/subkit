import type { DraftClock } from "../core/draft.ts";
import type {
  AuthoringMode,
  ConnectorDraftDocument,
  LatestDiagnosisSummary,
  LatestExecutionSummary,
  PersistedResourceRef,
  WorkflowDraftDocument,
} from "../types.ts";

export const NOW = "2026-11-06T08:00:00.000Z";
export const now: DraftClock = () => NOW;

export const MODES: AuthoringMode[] = [
  "onboarding",
  "connector_authoring",
  "workflow_authoring",
  "resume_review",
];

export const INTAKE_ID = "11111111-2222-4333-8444-555555555555";
export const OTHER_INTAKE_ID = "11111111-2222-4333-8444-666666666666";
export const WORKFLOW_UUID = "22222222-3333-4444-8555-666666666666";
export const VERSION_UUID = "33333333-4444-4555-8666-777777777777";
export const DIGEST = "a".repeat(64);

export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, stripNulls(v)]),
    );
  }
  return value;
}

export function workflow(
  steps: number,
  extra: Partial<WorkflowDraftDocument> = {},
): WorkflowDraftDocument {
  return {
    name: "orders-sync",
    slug: "orders-sync",
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, kind: "wait", duration_ms: i })),
    ...extra,
  };
}

export const connector: ConnectorDraftDocument = {
  name: "Orders API",
  slug: "orders-api",
  driver: "http",
  base_url: "https://orders.example.test",
  auth_type: "none",
};

export function resource(
  kind: "connector" | "workflow",
  extra: Partial<PersistedResourceRef> = {},
) {
  return {
    kind,
    id: `${kind}-1`,
    slug: kind === "workflow" ? "orders-sync" : "orders-api",
    name: kind === "workflow" ? "orders-sync" : "Orders API",
    version_id: kind === "workflow" ? "version-1" : null,
    version: 1,
    environment: "dev",
    saved_at: NOW,
    ...extra,
  } satisfies PersistedResourceRef;
}

export function execution(extra: Partial<LatestExecutionSummary> = {}): LatestExecutionSummary {
  return {
    execution_id: "execution-1",
    workflow_id: "workflow-1",
    workflow_version_id: "version-1",
    status: "succeeded",
    environment: "dev",
    warnings_count: 0,
    recorded_at: NOW,
    diagnosis_available: false,
    ...extra,
  };
}

export const diagnosis: LatestDiagnosisSummary = {
  execution_id: "execution-1",
  recorded_at: NOW,
  reason: "Step s0 returned no rows.",
  warning_sources: [{ step_key: "s0", code: "empty", identifier: null }],
  steps: [{ step_key: "s0", kind: "wait", status: "succeeded", duration_ms: 1 }],
};
