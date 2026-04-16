// Discovery service — run lifecycle, file analysis, synthesis, artifact review.
//
// Discovery runs are created implicitly when files are attached to
// conversations and analyzed. The service also supports programmatic
// creation via the REST API.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { discoveryArtifacts, discoveryFiles, discoveryRuns } from "../db/schema/discovery.ts";
import { detectFormat, parseFileToChunks } from "../knowledge/parsers.ts";
import { logger } from "../logging/logger.ts";
import type {
  CreateDiscoveryRunParams,
  DiscoveryArtifactView,
  DiscoveryRunView,
  ListDiscoveryArtifactsParams,
  ListDiscoveryRunsParams,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

    if (!run) throw new Error("discovery_runs insert returned no row");

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

  const conds = [eq(discoveryRuns.tenant_id, p.tenant_id)];
  if (p.status) conds.push(eq(discoveryRuns.status, p.status));

  const rows = await db
    .select()
    .from(discoveryRuns)
    .where(and(...conds))
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

  const conds = [
    eq(discoveryArtifacts.tenant_id, p.tenant_id),
    eq(discoveryArtifacts.run_id, p.run_id),
  ];
  if (p.kind) conds.push(eq(discoveryArtifacts.kind, p.kind));
  if (p.status) conds.push(eq(discoveryArtifacts.status, p.status));

  const rows = await db
    .select()
    .from(discoveryArtifacts)
    .where(and(...conds))
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
    // Knowledge Source) happens via the conversation tools (propose_connector,
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
