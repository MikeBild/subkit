import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import { discoveryArtifacts, discoveryFiles, discoveryRuns } from "../db/schema/discovery.ts";
import { linkStoredFile } from "../files/links.ts";
import { detectFormat, parseFileToChunks } from "../knowledge/parsers.ts";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/index.ts";
import type {
  CreateDiscoveryRunParams,
  DiscoveryArtifactStatus,
  DiscoveryArtifactView,
  DiscoveryRunView,
  ListDiscoveryArtifactsParams,
  ListDiscoveryRunsParams,
} from "./types.ts";

function discoveryAuditActor(actor: Actor | null | undefined, legacyActorId?: string | null) {
  if (actor) return auditActor(actor);
  if (legacyActorId) return { actor_type: "unknown" as const, actor_id: null };
  return auditActor(null);
}

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

export async function createDiscoveryRun(
  p: CreateDiscoveryRunParams,
  db: Executor,
): Promise<DiscoveryRunView> {
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

    if (p.archive_file_id) {
      await linkStoredFile(
        tx,
        {
          tenant_id: p.tenant_id,
          file_id: p.archive_file_id,
          resource_type: "discovery_run",
          resource_id: run.id,
          role: "archive",
        },
        {
          ...discoveryAuditActor(p.actor, p.actor_id),
          request_source: getContext().request_source ?? "tool-chain",
          source: "discovery_archive",
          allowed_statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
        },
      );
    }

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
        ...discoveryAuditActor(p.actor, p.actor_id),
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

export async function getDiscoveryRun(
  tenant_id: string,
  run_id: string,
  db: Executor,
): Promise<DiscoveryRunView | null> {
  const rows = await db
    .select()
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.tenant_id, tenant_id), eq(discoveryRuns.id, run_id)))
    .limit(1);
  return rows[0] ? toRunView(rows[0]) : null;
}

export async function listDiscoveryRuns(
  p: ListDiscoveryRunsParams,
  db: Executor,
): Promise<DiscoveryRunView[]> {
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
  db: Executor,
): Promise<DiscoveryArtifactView[]> {
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
  db: Executor,
): Promise<DiscoveryArtifactView | null> {
  const rows = await db
    .select()
    .from(discoveryArtifacts)
    .where(and(eq(discoveryArtifacts.tenant_id, tenant_id), eq(discoveryArtifacts.id, artifact_id)))
    .limit(1);
  return rows[0] ? toArtifactView(rows[0]) : null;
}

export async function approveDiscoveryArtifact(
  params: {
    tenant_id: string;
    artifact_id: string;
    actor_id?: string | null;
    actor?: Actor | null;
  },
  db: Executor,
): Promise<{ materialized_id: string | null; materialized_type: string | null } | null> {
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

    await tx
      .update(discoveryArtifacts)
      .set({ status: "approved", updated_at: new Date() })
      .where(eq(discoveryArtifacts.id, params.artifact_id));

    await auditAwait(
      {
        tenant_id: params.tenant_id,
        ...discoveryAuditActor(params.actor, params.actor_id),
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
    actor?: Actor | null;
    reason?: string;
  },
  db: Executor,
): Promise<boolean> {
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
        ...discoveryAuditActor(params.actor, params.actor_id),
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

const CAPABILITY_GAP_RUN_LABEL = "__capability_gaps__";

function normalizeIntent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

type SuggestedGapKind = "connector" | "workflow" | "knowledge" | "unknown";

interface RecordGapCandidateParams {
  tenant_id: string;
  conversation_id: string | null;
  requested: string;
  missing_capability: string | null;
  suggested_kind?: SuggestedGapKind;
  actor_id?: string | null;
  actor?: Actor | null;
}

interface CapabilityGapDraft {
  requested: string;
  missing_capability: string | null;
  suggested_kind: SuggestedGapKind;
  fingerprint: string;
  occurrences: number;
  conversation_id: string | null;
  resolution?: CapabilityGapResolution;
}

interface CapabilityGapResolution {
  note: string;
  resolved_at: string;
}

type CapabilityGapState = "open" | "accepted" | "declined" | "resolved";

const GAP_STATE_BY_STATUS: Record<DiscoveryArtifactStatus, CapabilityGapState> = {
  proposed: "open",
  approved: "accepted",
  rejected: "declined",
  superseded: "resolved",
};

function capabilityGapState(status: DiscoveryArtifactStatus): CapabilityGapState {
  return GAP_STATE_BY_STATUS[status];
}

interface CapabilityGapView {
  id: string;
  status: DiscoveryArtifactStatus;
  state: CapabilityGapState;
  missing_capability: string | null;
  requested: string;
  suggested_kind: SuggestedGapKind;
  occurrences: number;
  resolution: CapabilityGapResolution | null;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function toCapabilityGapView(gap: DiscoveryArtifactView): CapabilityGapView {
  const d = gap.draft as Partial<CapabilityGapDraft>;
  return {
    id: gap.id,
    status: gap.status,
    state: capabilityGapState(gap.status),
    missing_capability: d.missing_capability ?? null,
    requested: d.requested ?? gap.title,
    suggested_kind: d.suggested_kind ?? "unknown",
    occurrences: d.occurrences ?? 1,
    resolution: d.resolution ?? null,
    decline_reason: gap.rejection_reason,
    created_at: gap.created_at,
    updated_at: gap.updated_at,
  };
}

export async function resolveCapabilityGap(
  params: {
    tenant_id: string;
    artifact_id: string;
    note: string;
    actor_id?: string | null;
    actor?: Actor | null;
  },
  db: Executor,
): Promise<DiscoveryArtifactView | null> {
  return await (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(discoveryArtifacts)
      .where(
        and(
          eq(discoveryArtifacts.tenant_id, params.tenant_id),
          eq(discoveryArtifacts.id, params.artifact_id),
          eq(discoveryArtifacts.kind, "capability_gap"),
          inArray(discoveryArtifacts.status, ["proposed", "approved"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const resolution: CapabilityGapResolution = {
      note: params.note,
      resolved_at: new Date().toISOString(),
    };
    const draft = { ...(row.draft as Record<string, unknown>), resolution };
    const updated = await tx
      .update(discoveryArtifacts)
      .set({ status: "superseded", draft, updated_at: new Date() })
      .where(
        and(
          eq(discoveryArtifacts.tenant_id, params.tenant_id),
          eq(discoveryArtifacts.id, params.artifact_id),
        ),
      )
      .returning();
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        ...discoveryAuditActor(params.actor, params.actor_id),
        action: AuditAction.DISCOVERY_ARTIFACT_SUPERSEDED,
        resource_type: "discovery_artifact",
        resource_id: params.artifact_id,
        result: "success",
        metadata: { kind: row.kind, previous_status: row.status, note: params.note },
      },
      tx,
    );
    return updated[0] ? toArtifactView(updated[0]) : null;
  });
}

export async function recordGapCandidate(
  p: RecordGapCandidateParams,
  db: Executor,
): Promise<DiscoveryArtifactView | null> {
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
          ...discoveryAuditActor(p.actor, p.actor_id),
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

interface ListCapabilityGapsParams {
  tenant_id: string;
  status?: DiscoveryArtifactStatus;
  limit?: number;
}

export async function listCapabilityGaps(
  p: ListCapabilityGapsParams,
  db: Executor,
): Promise<DiscoveryArtifactView[]> {
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
