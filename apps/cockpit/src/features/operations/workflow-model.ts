export type StepRowState = "done" | "active" | "failed" | "pending";
export type StepRowKind = "read" | "write" | "compute";

export interface StepRowSource {
  id: string;
  kind: string;
  name: string | null;
  connector: string | null;
  target: string | null;
  writes: boolean | null;
  lastStatus: string | null;
}

export interface StepRow {
  id: string;
  label: string;
  reads: string[];
  writes: string[];
  kind: StepRowKind;
  state: StepRowState;
}

const DONE = new Set(["succeeded", "completed", "skipped"]);
const ACTIVE = new Set(["running", "queued", "pending", "waiting"]);
const FAILED = new Set(["failed", "timed_out", "error", "aborted", "cancelled"]);

export function stepRowState(status: string | null): StepRowState {
  if (!status) return "pending";
  if (DONE.has(status)) return "done";
  if (ACTIVE.has(status)) return "active";
  if (FAILED.has(status)) return "failed";
  return "pending";
}

export function stepRows(steps: readonly StepRowSource[]): StepRow[] {
  return steps.map((step) => {
    const ref = step.connector
      ? step.target
        ? `${step.connector}: ${step.target}`
        : step.connector
      : null;
    const writes = ref !== null && step.writes !== false;
    return {
      id: step.id,
      label: step.name ?? step.id,
      reads: ref !== null && !writes ? [ref] : [],
      writes: writes && ref !== null ? [ref] : [],
      kind: writes ? "write" : ref !== null ? "read" : "compute",
      state: stepRowState(step.lastStatus),
    };
  });
}

export function boundaryCounts(rows: readonly StepRow[]): {
  reads: number;
  writes: number;
  services: number;
} {
  const reads = new Set(rows.flatMap((row) => row.reads));
  const writes = new Set(rows.flatMap((row) => row.writes));
  const services = new Set([...reads, ...writes].map((ref) => ref.split(":")[0]?.trim() ?? ref));
  return { reads: reads.size, writes: writes.size, services: services.size };
}

export function graphState(state: StepRowState): "done" | "active" | "pending" {
  return state === "done"
    ? "done"
    : state === "active" || state === "failed"
      ? "active"
      : "pending";
}

export interface ApprovalFacts {
  environment: "dev" | "prod";
  validUntil: string | null;
  createdBy: string;
  createdAt: string;
  used: number;
  maxRuns: number | null;
}

export function currentApproval<
  A extends {
    state: string;
    revoked_at: string | null;
    superseded_by: string | null;
    execution_environment: "dev" | "prod";
    valid_until: string | null;
    created_by: string;
    created_at: string;
    reserved_runs: number;
    max_runs: number | null;
  },
>(authorities: readonly A[] | null): (ApprovalFacts & { source: A }) | null {
  if (!authorities) return null;
  const live = authorities
    .filter((entry) => entry.state === "approved" && entry.revoked_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!live) return null;
  return {
    environment: live.execution_environment,
    validUntil: live.valid_until,
    createdBy: live.created_by,
    createdAt: live.created_at,
    used: live.reserved_runs,
    maxRuns: live.max_runs,
    source: live,
  };
}
