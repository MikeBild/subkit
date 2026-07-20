// Discovery service — run lifecycle, file analysis, synthesis, artifact review.
//
// Discovery runs are created implicitly when files are attached to
// conversations and analyzed. The service also supports programmatic
// creation via the REST API.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { discoveryArtifacts, discoveryFiles, discoveryRuns } from "../db/schema/discovery.ts";
import { fileLinks } from "../db/schema/files.ts";
import { detectFormat, parseFileToChunks } from "../knowledge/parsers.ts";
import { logger } from "../logging/logger.ts";
import type {
  CreateDiscoveryRunParams,
  DiscoveryArtifactStatus,
  DiscoveryArtifactView,
  DiscoveryRunView,
  ListDiscoveryArtifactsParams,
  ListDiscoveryRunsParams,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRunView(row: typeof discoveryRuns.$inferSelect): DiscoveryRunView {
  const usage = (row.token_usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }) as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    conversation_id: row.conversation_id,
    status: row.status,
    label: row.label,
    file_count: row.file_count,
    files_analyzed: row.files_analyzed,
    artifact_count: row.artifact_count,
    token_usage: usage,
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toArtifactView(row: typeof discoveryArtifacts.$inferSelect): DiscoveryArtifactView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    description: row.description,
    draft: row.draft as Record<string, unknown>,
    evidence: row.evidence as {
      file_ids: string[];
      excerpts: Array<{ file_id: string; filename: string; text: string }>;
    },
    confidence: row.confidence,
    materialized_id: row.materialized_id,
    materialized_type: row.materialized_type,
    rejection_reason: row.rejection_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export async function createDiscoveryRun(
  p: CreateDiscoveryRunParams,
  exec?: Executor,
): Promise<DiscoveryRunView> {
  const db = exec ?? getDb();

  // Parse all files OUTSIDE the transaction. Failures are recorded in the
  // parsed results so the transaction only does clean inserts.
  interface ParsedFile {
    filename: string;
    mime_type: string | null;
    byte_size: number;
    format: string;
    content: string | null;
    chunk_count: number;
    status: string;
    error: string | null;
    fingerprint: string | null;
  }
  const parsedFiles: ParsedFile[] = [];
  for (const file of p.files) {
    try {
      const content =
        typeof file.buffer === "string" ? file.buffer : new TextDecoder().decode(file.buffer);

      // PostgreSQL TEXT columns reject null bytes — detect and fail early
      if (content.includes("\x00")) {
        throw new Error("File contains null bytes — binary files are not supported");
      }

      const format = detectFormat(file.filename, file.mime);
      const rawChunks = parseFileToChunks(content, file.filename, format);
      const fingerprint = createHash("sha256").update(content).digest("hex").slice(0, 32);
      parsedFiles.push({
        filename: file.filename,
        mime_type: file.mime ?? null,
        byte_size: Buffer.byteLength(content, "utf8"),
        format,
        content,
        chunk_count: rawChunks.length,
        status: "pending",
        error: null,
        fingerprint,
      });
    } catch (err) {
      logger.warn({
        module: "discovery",
        action: "discovery.file_parse_failed",
        msg: `Failed to parse file: ${file.filename}`,
        error: err instanceof Error ? err.message : String(err),
        filename: file.filename,
      });
      parsedFiles.push({
        filename: file.filename,
        mime_type: file.mime ?? null,
        byte_size: 0,
        format: "unknown",
        content: null,
        chunk_count: 0,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        fingerprint: null,
      });
    }
  }

  const parsedCount = parsedFiles.filter((f) => f.status !== "failed").length;

  return await (db as Db).transaction(async (tx) => {
    const [run] = await tx
      .insert(discoveryRuns)
      .values({
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id ?? null,
        label: p.label ?? null,
        file_count: p.files.length,
        status: "pending",
        started_at: new Date(),
      })
      .returning();

    assertInsertRow(run, "discovery_runs");

    // Link the persisted raw-archive file (canonical `files` row) to the
    // run. The extracted text still lands in `discovery_files` below —
    // this link is what keeps the original binary upload retrievable.
    if (p.archive_file_id) {
      await tx
        .insert(fileLinks)
        .values({
          tenant_id: p.tenant_id,
          file_id: p.archive_file_id,
          resource_type: "discovery_run",
          resource_id: run.id,
          role: "archive",
        })
        .onConflictDoNothing();
    }

    // Insert all pre-parsed files in a clean transaction
    for (const pf of parsedFiles) {
      await tx.insert(discoveryFiles).values({
        tenant_id: p.tenant_id,
        run_id: run.id,
        filename: pf.filename,
        mime_type: pf.mime_type,
        byte_size: pf.byte_size,
        format: pf.format,
        content: pf.content,
        chunk_count: pf.chunk_count,
        status: pf.status,
        error: pf.error,
        fingerprint: pf.fingerprint,
      });
    }

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.DISCOVERY_RUN_CREATED,
        resource_type: "discovery_run",
        resource_id: run.id,
        result: "success",
        metadata: {
          file_count: p.files.length,
          parsed_count: parsedCount,
          label: p.label ?? null,
        },
      },
      tx,
    );

    return toRunView(run);
  });
}

// ---------------------------------------------------------------------------
// Run status transitions
// ---------------------------------------------------------------------------

export async function markRunAnalyzing(
  tenant_id: string,
  run_id: string,
  exec?: Executor,
): Promise<void> {
  const db = exec ?? getDb();
  await db
    .update(discoveryRuns)
    .set({ status: "analyzing", updated_at: new Date() })
    .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)));
}

export async function markRunCompleted(
  tenant_id: string,
  run_id: string,
  artifact_count: number,
  exec?: Executor,
): Promise<void> {
  const db = exec ?? getDb();
  await (db as Db).transaction(async (tx) => {
    await tx
      .update(discoveryRuns)
      .set({
        status: "completed",
        artifact_count,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)));

    // Clear file content after analysis to reclaim storage
    await tx.update(discoveryFiles).set({ content: null }).where(eq(discoveryFiles.run_id, run_id));

    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.DISCOVERY_RUN_COMPLETED,
        resource_type: "discovery_run",
        resource_id: run_id,
        result: "success",
        metadata: { artifact_count },
      },
      tx,
    );
  });
}

export async function markRunFailed(
  tenant_id: string,
  run_id: string,
  error: string,
  exec?: Executor,
): Promise<void> {
  const db = exec ?? getDb();
  await (db as Db).transaction(async (tx) => {
    await tx
      .update(discoveryRuns)
      .set({
        status: "failed",
        error,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)));

    await auditAwait(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.DISCOVERY_RUN_FAILED,
        resource_type: "discovery_run",
        resource_id: run_id,
        result: "error",
        metadata: { error },
      },
      tx,
    );
  });
}

export async function markFileAnalyzed(file_id: string, exec?: Executor): Promise<void> {
  const db = exec ?? getDb();
  await db
    .update(discoveryFiles)
    .set({ status: "analyzed", content: null, updated_at: new Date() })
    .where(eq(discoveryFiles.id, file_id));
}

export async function incrementFilesAnalyzed(
  tenant_id: string,
  run_id: string,
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  const [row] = await db
    .update(discoveryRuns)
    .set({
      files_analyzed: sql`${discoveryRuns.files_analyzed} + 1`,
      updated_at: new Date(),
    })
    .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)))
    .returning({ files_analyzed: discoveryRuns.files_analyzed });
  return row?.files_analyzed ?? 0;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getDiscoveryRun(
  tenant_id: string,
  run_id: string,
  exec?: Executor,
): Promise<DiscoveryRunView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)))
    .limit(1);
  return rows[0] ? toRunView(rows[0]) : null;
}

export async function listDiscoveryRuns(
  p: ListDiscoveryRunsParams,
  exec?: Executor,
): Promise<DiscoveryRunView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
  const offset = Math.max(0, p.offset ?? 0);

  const tenantConds = [eq(discoveryRuns.tenant_id, p.tenant_id)];
  if (p.status) tenantConds.push(eq(discoveryRuns.status, p.status));

  const rows = await db
    .select()
    .from(discoveryRuns)
    .where(and(...tenantConds))
    .orderBy(desc(discoveryRuns.created_at))
    .limit(limit)
    .offset(offset);

  return rows.map(toRunView);
}

export async function listDiscoveryArtifacts(
  p: ListDiscoveryArtifactsParams,
  exec?: Executor,
): Promise<DiscoveryArtifactView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
  const offset = Math.max(0, p.offset ?? 0);

  const tenantConds = [
    eq(discoveryArtifacts.tenant_id, p.tenant_id),
    eq(discoveryArtifacts.run_id, p.run_id),
  ];
  if (p.kind) tenantConds.push(eq(discoveryArtifacts.kind, p.kind));
  if (p.status) tenantConds.push(eq(discoveryArtifacts.status, p.status));

  const rows = await db
    .select()
    .from(discoveryArtifacts)
    .where(and(...tenantConds))
    .orderBy(desc(discoveryArtifacts.created_at))
    .limit(limit)
    .offset(offset);

  return rows.map(toArtifactView);
}

export async function getDiscoveryArtifact(
  tenant_id: string,
  artifact_id: string,
  exec?: Executor,
): Promise<DiscoveryArtifactView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(discoveryArtifacts)
    .where(and(eq(discoveryArtifacts.tenant_id, tenant_id), eq(discoveryArtifacts.id, artifact_id)))
    .limit(1);
  return rows[0] ? toArtifactView(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Artifact review (human gate)
// ---------------------------------------------------------------------------

export async function approveDiscoveryArtifact(
  params: { tenant_id: string; artifact_id: string; actor_id: string | null },
  exec?: Executor,
): Promise<{ materialized_id: string | null; materialized_type: string | null } | null> {
  const db = exec ?? getDb();

  return await (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(discoveryArtifacts)
      .where(
        and(
          eq(discoveryArtifacts.tenant_id, params.tenant_id),
          eq(discoveryArtifacts.id, params.artifact_id),
          eq(discoveryArtifacts.status, "proposed"),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;
    const row = rows[0];

    // Mark approved — actual materialization (creating the Connector / Skill /
    // Knowledge Source) happens via the conversation tools (start_connector_from_*,
    // propose_skill) or via the caller after receiving the draft.
    await tx
      .update(discoveryArtifacts)
      .set({ status: "approved", updated_at: new Date() })
      .where(eq(discoveryArtifacts.id, params.artifact_id));

    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.DISCOVERY_ARTIFACT_APPROVED,
        resource_type: "discovery_artifact",
        resource_id: params.artifact_id,
        result: "success",
        metadata: { kind: row.kind, title: row.title },
      },
      tx,
    );

    return {
      materialized_id: row.materialized_id,
      materialized_type: row.materialized_type,
    };
  });
}

export async function rejectDiscoveryArtifact(
  params: {
    tenant_id: string;
    artifact_id: string;
    actor_id: string | null;
    reason?: string;
  },
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();

  return await (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(discoveryArtifacts)
      .where(
        and(
          eq(discoveryArtifacts.tenant_id, params.tenant_id),
          eq(discoveryArtifacts.id, params.artifact_id),
          eq(discoveryArtifacts.status, "proposed"),
        ),
      )
      .limit(1);

    if (!rows[0]) return false;

    await tx
      .update(discoveryArtifacts)
      .set({
        status: "rejected",
        rejection_reason: params.reason ?? null,
        updated_at: new Date(),
      })
      .where(eq(discoveryArtifacts.id, params.artifact_id));

    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.DISCOVERY_ARTIFACT_REJECTED,
        resource_type: "discovery_artifact",
        resource_id: params.artifact_id,
        result: "success",
        metadata: { reason: params.reason ?? null },
      },
      tx,
    );

    return true;
  });
}

// ---------------------------------------------------------------------------
// Capability gaps — the inverse of discovery.
//
// Recorded when the assistant calls `cannot_help`: the request could not
// be served because no connector / workflow / knowledge source exists for
// it. The old behaviour kept only a Prometheus counter, discarding the
// request text. We persist the gap as a `capability_gap` discovery
// artifact so the operator sees a deduped, demand-ranked backlog and can
// turn a recurring gap into a real capability through the same
// propose → approve lifecycle.
//
// A gap has no source files: its `draft` carries the requested intent,
// the missing capability, a dedup fingerprint and an occurrence counter;
// its `evidence` is empty. Gaps attach to a per-tenant pseudo-run so the
// notNull `run_id` contract holds without relaxing the schema.
// ---------------------------------------------------------------------------

/** Sentinel label for the per-tenant pseudo-run that owns capability-gap
 *  artifacts (they have no file run). */
const CAPABILITY_GAP_RUN_LABEL = "__capability_gaps__";

/** Local intent normaliser for the dedup key — identical in spirit to the
 *  ranking normaliser in context-assembler/loaders.ts, inlined to avoid a
 *  discovery → llm/core dependency. */
function normalizeIntent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type SuggestedGapKind = "connector" | "workflow" | "knowledge" | "unknown";

export interface RecordGapCandidateParams {
  tenant_id: string;
  conversation_id: string | null;
  /** What the user wanted / why it could not be served (cannot_help reason). */
  requested: string;
  /** Stable capability slug from cannot_help, when given. Primary dedup key. */
  missing_capability: string | null;
  suggested_kind?: SuggestedGapKind;
  actor_id?: string | null;
}

export interface CapabilityGapDraft {
  requested: string;
  missing_capability: string | null;
  suggested_kind: SuggestedGapKind;
  fingerprint: string;
  occurrences: number;
  conversation_id: string | null;
}

/**
 * Record (or increment) a capability gap. Idempotent by fingerprint:
 * the same (tenant, missing_capability | normalised intent) bumps an
 * occurrence counter instead of inserting a duplicate, so a recurring
 * gap floats to the top of the operator backlog by demand.
 *
 * Best-effort by contract — callers (cannot_help) must not let a failure
 * here break the turn; on error this logs and returns null.
 */
export async function recordGapCandidate(
  p: RecordGapCandidateParams,
  exec?: Executor,
): Promise<DiscoveryArtifactView | null> {
  const db = exec ?? getDb();
  const dedupKey =
    p.missing_capability && p.missing_capability.trim().length > 0
      ? p.missing_capability.trim().toLowerCase()
      : normalizeIntent(p.requested);
  if (dedupKey.length === 0) return null;
  const fingerprint = createHash("sha256")
    .update(`${p.tenant_id}:${dedupKey}`)
    .digest("hex")
    .slice(0, 32);
  const suggested_kind: SuggestedGapKind = p.suggested_kind ?? "unknown";

  try {
    return await (db as Db).transaction(async (tx) => {
      // Dedup: an existing proposed gap with this fingerprint just gets
      // its occurrence counter bumped (the demand signal).
      const [existing] = await tx
        .select()
        .from(discoveryArtifacts)
        .where(
          and(
            eq(discoveryArtifacts.tenant_id, p.tenant_id),
            eq(discoveryArtifacts.kind, "capability_gap"),
            eq(discoveryArtifacts.status, "proposed"),
            sql`${discoveryArtifacts.draft}->>'fingerprint' = ${fingerprint}`,
          ),
        )
        .limit(1);

      if (existing) {
        const [bumped] = await tx
          .update(discoveryArtifacts)
          .set({
            draft: sql`jsonb_set(${discoveryArtifacts.draft}, '{occurrences}', to_jsonb(COALESCE((${discoveryArtifacts.draft}->>'occurrences')::int, 1) + 1))`,
            updated_at: new Date(),
          })
          .where(eq(discoveryArtifacts.id, existing.id))
          .returning();
        assertInsertRow(bumped, "discovery_artifacts");
        return toArtifactView(bumped);
      }

      // First occurrence: ensure the per-tenant gap pseudo-run exists.
      const existingRuns = await tx
        .select({ id: discoveryRuns.id })
        .from(discoveryRuns)
        .where(
          and(
            eq(discoveryRuns.tenant_id, p.tenant_id),
            eq(discoveryRuns.label, CAPABILITY_GAP_RUN_LABEL),
          ),
        )
        .limit(1);
      let runId = existingRuns[0]?.id;
      if (!runId) {
        const [created] = await tx
          .insert(discoveryRuns)
          .values({
            tenant_id: p.tenant_id,
            conversation_id: null,
            label: CAPABILITY_GAP_RUN_LABEL,
            status: "completed",
            file_count: 0,
            completed_at: new Date(),
          })
          .returning({ id: discoveryRuns.id });
        assertInsertRow(created, "discovery_runs");
        runId = created.id;
      }

      const draft: CapabilityGapDraft = {
        requested: p.requested.slice(0, 2000),
        missing_capability: p.missing_capability,
        suggested_kind,
        fingerprint,
        occurrences: 1,
        conversation_id: p.conversation_id,
      };

      const [artifact] = await tx
        .insert(discoveryArtifacts)
        .values({
          tenant_id: p.tenant_id,
          run_id: runId,
          kind: "capability_gap",
          status: "proposed",
          title: `Missing capability: ${p.missing_capability ?? dedupKey}`.slice(0, 200),
          draft,
          evidence: { file_ids: [], excerpts: [] },
        })
        .returning();
      assertInsertRow(artifact, "discovery_artifacts");

      await tx
        .update(discoveryRuns)
        .set({ artifact_count: sql`${discoveryRuns.artifact_count} + 1` })
        .where(eq(discoveryRuns.id, runId));

      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: p.actor_id ? "user" : "system",
          actor_id: p.actor_id ?? null,
          action: AuditAction.DISCOVERY_ARTIFACT_PROPOSED,
          resource_type: "discovery_artifact",
          resource_id: artifact.id,
          result: "success",
          metadata: {
            kind: "capability_gap",
            missing_capability: p.missing_capability,
            fingerprint,
          },
        },
        tx,
      );

      return toArtifactView(artifact);
    });
  } catch (err) {
    logger.warn({
      module: "discovery",
      action: "capability_gap.record_failed",
      msg: "failed to record capability gap (non-fatal)",
      tenant_id: p.tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ListCapabilityGapsParams {
  tenant_id: string;
  status?: DiscoveryArtifactStatus;
  limit?: number;
}

/**
 * List capability gaps for a tenant, demand-ranked (highest occurrence
 * count first). Unlike `listDiscoveryArtifacts` this is not scoped to a
 * single run — gaps live under the per-tenant pseudo-run, so the operator
 * wants them aggregated across the tenant.
 */
export async function listCapabilityGaps(
  p: ListCapabilityGapsParams,
  exec?: Executor,
): Promise<DiscoveryArtifactView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
  const rows = await db
    .select()
    .from(discoveryArtifacts)
    .where(
      and(
        eq(discoveryArtifacts.tenant_id, p.tenant_id),
        eq(discoveryArtifacts.kind, "capability_gap"),
        p.status ? eq(discoveryArtifacts.status, p.status) : undefined,
      ),
    )
    .orderBy(
      desc(sql`COALESCE((${discoveryArtifacts.draft}->>'occurrences')::int, 1)`),
      desc(discoveryArtifacts.updated_at),
    )
    .limit(limit);
  return rows.map(toArtifactView);
}
