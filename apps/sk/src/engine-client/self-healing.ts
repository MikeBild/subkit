// Self-healing surfaces of the engine client: the operator health
// digest, patch candidates, and self-healing scans. Method group merged
// into `EngineClient` by `../engine-client.ts`.

import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";

// Operator health digest — mirrors apps/engine/src/operator/health-digest.ts.
export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";
export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  /**
   * How many of these runs the scheduler started. `origin` collapses to
   * "mixed" once a group holds more than one kind, so it cannot answer this.
   *
   * Optional because this CLI talks to engines it did not ship with: an engine
   * older than the field simply omits it. Read it through `scheduledRunsOf`,
   * never directly — `undefined > 0` is false, which would render every
   * failing production schedule as a harmless trial run.
   */
  scheduled_count?: number;
  last_seen: string;
  /**
   * The workflow's most recent clean run on its own schedule, when that run is
   * newer than the group's last failure; null while the cause is live. Optional for the same reason as `scheduled_count` — an
   * older engine omits it. Read it through `resolvedAtOf`: `undefined` must
   * mean "this engine cannot tell", not "still broken".
   */
  resolved_at?: string | null;
  cause: string;
  guidance: string | null;
}
export interface DigestPatch {
  id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  classification: "safe" | "unsafe";
  summary: string;
}
export type RiskSeverity = "warn" | "critical";
export interface RiskSignal {
  kind: string;
  severity: RiskSeverity;
  headline: string;
  detail: string;
  metric: string;
  value: number;
  threshold: number;
}
export interface OperatorHealthDigest {
  generated_at: string;
  window_hours: number;
  headline: string;
  failure_groups: DigestFailureGroup[];
  patch_candidates: { pending: number; items: DigestPatch[] };
  risk: RiskSignal[];
  rendered: string;
  all_clear: boolean;
}

export const selfHealingMethods = {
  // -------------------- Operator --------------------
  /**
   * Deterministic operator health digest — failed runs grouped by root
   * cause + tagged by origin, plus pending self-healing fixes. The REPL
   * renders this as a colored first assistant turn at startup.
   */
  getOperatorHealthDigest(
    this: EngineClient,
    query: { window_hours?: number } = {},
  ): Promise<OperatorHealthDigest> {
    return this.request(
      "GET",
      "/v1/operator/health-digest",
      undefined,
      query,
    ) as Promise<OperatorHealthDigest>;
  },

  // -------------------- Patch Candidates --------------------
  listPatchCandidates(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/patch-candidates", undefined, query);
  },
  getPatchCandidate(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/patch-candidates/${encodeURIComponent(id)}`);
  },
  async approvePatchCandidate(
    this: EngineClient,
    id: string,
    expected_review_digest: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/patch-candidates/${encodeURIComponent(id)}/approve`,
      { expected_review_digest },
    );
    if (
      result.applied !== true ||
      typeof result.workflow_version_id !== "string" ||
      !result.workflow_version_id
    ) {
      throw new EngineError(409, {
        code: "patch_not_applicable",
        message: "The repair was not applied. Reload the candidate preview before approving.",
      });
    }
    return result;
  },
  rejectPatchCandidate(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/patch-candidates/${encodeURIComponent(id)}/reject`, body);
  },

  // -------------------- Self-Healing Scans --------------------
  triggerSelfHealingScan(
    this: EngineClient,
    body: { workflow_id?: string; connector_id?: string } = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const extraHeaders = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request("POST", "/v1/self-healing/scans", body, undefined, undefined, extraHeaders);
  },
  listSelfHealingScans(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/self-healing/scans", undefined, query);
  },
  getSelfHealingScan(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/self-healing/scans/${encodeURIComponent(id)}`);
  },
};

/**
 * How many of a group's runs the scheduler started, also from an engine that
 * does not report it yet.
 *
 * The fallback is the best the old shape allows: `scheduled` meant every run,
 * anything else meant none. It gets "mixed" wrong in the old direction, which
 * is what the field exists to fix — but it keeps a mixed-version pair honest
 * about the ordinary cases instead of silently downgrading all of them.
 */
export function scheduledRunsOf(group: DigestFailureGroup): number {
  if (typeof group.scheduled_count === "number") return group.scheduled_count;
  return group.origin === "scheduled" ? group.count : 0;
}

/**
 * When a group's workflow last ran clean on its schedule, or null.
 *
 * An engine that does not report the field answers null — the safe direction:
 * an unresolved cause stays on screen, where a human decides it is over. The
 * opposite default would hide a live incident because the engine was old.
 */
export function resolvedAtOf(group: DigestFailureGroup): string | null {
  return group.resolved_at ?? null;
}
