import { workflowJsonDigest } from "../canonical-json.ts";

export const AUTHORITY_WINDOW_MAX_DAYS = 31;
export const DAY_MS = 86_400_000;
export const AUTHORITY_WINDOW_MAX_MS = AUTHORITY_WINDOW_MAX_DAYS * DAY_MS;
export const AUTHORITY_REPLACEMENT_MAX_HOPS = 32;

interface AuthorityRuns {
  max_runs: number | null;
  reserved_runs: number;
}

export interface AuthorityLiveness extends AuthorityRuns {
  revoked_at: Date | null;
  valid_from: Date;
  valid_until: Date | null;
}

export interface AuthorityBoundary {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_environment: string;
  effect_manifest_digest: string;
  max_runs: number | null;
  inherited_from: string | null;
  target_constraints: unknown;
  superseded_by: string | null;
}

export function remainingRuns(row: AuthorityRuns): number | null {
  return row.max_runs === null ? null : Math.max(0, row.max_runs - row.reserved_runs);
}

export function isOpenEnded(row: { valid_until: Date | null; max_runs: number | null }): boolean {
  return row.valid_until === null && row.max_runs === null;
}

export function windowValid(validFrom: Date, validUntil: Date | null, now: Date): boolean {
  if (!validUntil) return true;
  return (
    validUntil > validFrom &&
    validUntil > now &&
    validUntil.getTime() - validFrom.getTime() <= AUTHORITY_WINDOW_MAX_MS
  );
}

export function isLive(authority: AuthorityLiveness, now: Date): boolean {
  return (
    authority.revoked_at === null &&
    authority.valid_from <= now &&
    (authority.valid_until === null || authority.valid_until > now) &&
    remainingRuns(authority) !== 0
  );
}

export function sameBoundary(next: AuthorityBoundary, origin: AuthorityBoundary): boolean {
  return (
    next.workflow_id === origin.workflow_id &&
    next.workflow_version_id === origin.workflow_version_id &&
    next.execution_environment === origin.execution_environment &&
    next.effect_manifest_digest === origin.effect_manifest_digest &&
    next.max_runs === origin.max_runs &&
    next.inherited_from === null &&
    workflowJsonDigest(next.target_constraints) === workflowJsonDigest(origin.target_constraints)
  );
}

export function replacementFor(chain: ReadonlyArray<AuthorityBoundary>, originId: string): string {
  const byId = new Map(chain.map((row) => [row.id, row]));
  const origin = byId.get(originId);
  if (!origin) return originId;
  let current = origin;
  for (let hop = 0; hop < AUTHORITY_REPLACEMENT_MAX_HOPS && current.superseded_by; hop++) {
    const next = byId.get(current.superseded_by);
    if (!next || !sameBoundary(next, origin)) break;
    current = next;
  }
  return current.id;
}

type CarryForwardDecision =
  | { kind: "growth" }
  | { kind: "exhausted" }
  | { kind: "carry"; max_runs: number | null; valid_until: Date | null };

export function carryForward(
  parent: AuthorityRuns & { valid_until: Date | null },
  growth: ReadonlyArray<unknown>,
): CarryForwardDecision {
  if (growth.length > 0) return { kind: "growth" };
  const remaining = remainingRuns(parent);
  if (remaining === 0) return { kind: "exhausted" };
  return { kind: "carry", max_runs: remaining, valid_until: parent.valid_until };
}

export function workflowAuthorityExecutionOptions(environment: "dev" | "prod") {
  return {
    execution_mode: environment,
    self_healing: { enabled: false },
    hold_writes: false,
  } as const;
}

export function workflowAuthorityOptionsDigest(
  environment: "dev" | "prod",
  defaults: Readonly<{
    workflow_timeout_ms: number;
    request_timeout_ms: number;
    request_max_retries: number;
  }>,
): string {
  return workflowJsonDigest({
    ...workflowAuthorityExecutionOptions(environment),
    default_workflow_timeout_ms: defaults.workflow_timeout_ms,
    default_request_timeout_ms: defaults.request_timeout_ms,
    default_request_max_retries: defaults.request_max_retries,
    step_output_fixtures: null,
  });
}
