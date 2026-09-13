// Proactive sk-stdlib drift scan.
//
// Unlike the shape-drift path (which is driven by a failing step), the
// stdlib-version drift is surfaced proactively: the engine's current
// STDLIB_VERSION is compared against the version recorded on every
// persisted workflow and before-request-hook. A major-version gap
// means the surface may have changed semantically — operators get a
// Patch Candidate to review before the next run.
//
// This module is pure + DB-only; it does not propose patches. The
// caller (self-healing service or a scheduled job) turns the emitted
// signals into PatchCandidate rows.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Db, Executor } from "../db/client.ts";
import { requestHooks } from "../db/schema/request_hooks.ts";
import { workflows, workflowVersions } from "../db/schema/workflows.ts";
import { detectStdlibDrift } from "../sandboxes/quickjs/stdlib/drift.ts";
import type { DriftSignal } from "./types.ts";

interface WorkflowDagRuntime {
  stdlib_version?: unknown;
}

function readDagStdlibVersion(dag: unknown): string | null {
  if (!dag || typeof dag !== "object") return null;
  const runtime = (dag as { runtime?: WorkflowDagRuntime }).runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const v = runtime.stdlib_version;
  return typeof v === "string" ? v : null;
}

/**
 * Scan every current workflow version and every enabled request hook
 * in the tenant and return a `stdlib_version_drift` signal for each
 * major-version mismatch against the engine's STDLIB_VERSION.
 *
 * Pure + read-only: issuing the signals to the Patch-Candidate table
 * is the caller's responsibility.
 */
export async function scanStdlibDrift(tenant_id: string, exec?: Executor): Promise<DriftSignal[]> {
  const db: Executor = exec ?? ((await import("../db/client.ts")).getDb() as Db);
  const out: DriftSignal[] = [];

  // Workflows: join workflows → current version, skip soft-deleted rows.
  const wfRows = await db
    .select({
      workflow_id: workflows.id,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflows.current_version_id, workflowVersions.id))
    .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)));

  for (const row of wfRows) {
    const recorded = readDagStdlibVersion(row.dag);
    const drift = detectStdlibDrift(recorded);
    if (!drift) continue;
    out.push({
      kind: "stdlib_version_drift",
      surface: "workflow",
      resource_id: row.workflow_id,
      recorded_version: drift.recorded_version,
      current_version: drift.current_version,
      recorded_major: drift.recorded_major,
      current_major: drift.current_major,
    });
  }

  const hookRows = await db
    .select({
      id: requestHooks.id,
      stdlib_version: requestHooks.stdlib_version,
    })
    .from(requestHooks)
    .where(
      and(
        eq(requestHooks.tenant_id, tenant_id),
        eq(requestHooks.enabled, true),
        isNotNull(requestHooks.stdlib_version),
      ),
    );

  for (const row of hookRows) {
    const drift = detectStdlibDrift(row.stdlib_version);
    if (!drift) continue;
    out.push({
      kind: "stdlib_version_drift",
      surface: "request_hook",
      resource_id: row.id,
      recorded_version: drift.recorded_version,
      current_version: drift.current_version,
      recorded_major: drift.recorded_major,
      current_major: drift.current_major,
    });
  }

  return out;
}
