// Skill CRUD + lifecycle. Skills are hand-authored and curated — the
// engine never mutates them. Every write bumps `version` and writes an
// audit entry. The retrieval helpers below are the canonical read path
// used by the Context Enhancement pipeline.

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { auditLog, skills } from "../db/schema/index.ts";
import { ConflictError, HttpError, NotFoundError } from "../http/errors.ts";
import { log } from "../logging/logger.ts";
import {
  type CreateSkillInput,
  type Skill,
  type SkillExamplesBlob,
  type SkillLifecycle,
  SkillSchema,
  type SkillScope,
  type SkillSource,
  type UpdateSkillInput,
} from "./types.ts";

type SkillRow = typeof skills.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function blobToFields(blob: unknown): Required<SkillExamplesBlob> {
  const b = (blob ?? {}) as SkillExamplesBlob;
  return {
    examples: Array.isArray(b.examples) ? b.examples : [],
    best_practices: Array.isArray(b.best_practices) ? b.best_practices : [],
    pitfalls: Array.isArray(b.pitfalls) ? b.pitfalls : [],
    doc_refs: Array.isArray(b.doc_refs) ? b.doc_refs : [],
  };
}

function rowToSkill(row: SkillRow): Skill {
  const fields = blobToFields(row.examples);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope: row.scope as SkillScope,
    connector_id: row.connector_id ?? null,
    workflow_id: row.workflow_id ?? null,
    slug: row.slug ?? null,
    title: row.title,
    body: row.body,
    examples: fields.examples,
    best_practices: fields.best_practices,
    pitfalls: fields.pitfalls,
    doc_refs: fields.doc_refs,
    gates_tools: Array.isArray(row.gates_tools) ? (row.gates_tools as string[]) : [],
    activates_when: Array.isArray(row.activates_when)
      ? (row.activates_when as Skill["activates_when"])
      : [],
    input_schema: row.input_schema ?? null,
    output_schema: row.output_schema ?? null,
    side_effects: row.side_effects as Skill["side_effects"],
    idempotency: row.idempotency as Skill["idempotency"],
    maturity: row.maturity as Skill["maturity"],
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    status: row.lifecycle as SkillLifecycle,
    source: row.source as SkillSource,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function validateScope(input: {
  scope: SkillScope;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
}): void {
  if (input.scope === "connector" && !input.connector_id) {
    throw new Error("connector skill requires connector_id");
  }
  if (input.scope === "workflow" && !input.workflow_id) {
    throw new Error("workflow skill requires workflow_id");
  }
  if (input.scope === "global" && (input.connector_id || input.workflow_id)) {
    throw new Error("global skill must not set connector_id or workflow_id");
  }
  if (input.connector_id && input.workflow_id) {
    throw new Error("skill cannot set both connector_id and workflow_id");
  }
}

export interface CreateSkillParams {
  tenant_id: string;
  input: CreateSkillInput;
  actor_id?: string | null;
}

export async function createSkill(p: CreateSkillParams, exec?: Executor): Promise<Skill> {
  const db = exec ?? getDb();
  validateScope(p.input);
  const blob: SkillExamplesBlob = {
    examples: p.input.examples ?? [],
    best_practices: p.input.best_practices ?? [],
    pitfalls: p.input.pitfalls ?? [],
    doc_refs: p.input.doc_refs ?? [],
  };
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(skills)
      .values({
        tenant_id: p.tenant_id,
        scope: p.input.scope,
        connector_id: p.input.connector_id ?? null,
        workflow_id: p.input.workflow_id ?? null,
        title: p.input.title,
        body: p.input.body,
        examples: blob,
        lifecycle: p.input.status ?? "active",
        source: p.input.source ?? "manual",
        version: 1,
        gates_tools: p.input.gates_tools ?? [],
        activates_when: p.input.activates_when ?? [],
        input_schema: p.input.input_schema ?? null,
        output_schema: p.input.output_schema ?? null,
        side_effects: p.input.side_effects ?? "read",
        idempotency: p.input.idempotency ?? "none",
        maturity: p.input.maturity ?? "stable",
        tags: p.input.tags ?? [],
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "skills");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id ?? null,
        action: AuditAction.SKILL_CREATED,
        resource_type: "skill",
        resource_id: row.id,
        result: "success",
        metadata: {
          scope: row.scope,
          title: row.title,
          status: row.lifecycle,
        },
      },
      tx,
    );
    log.skill.created({
      skill_id: row.id,
      tenant_id: p.tenant_id,
      scope: row.scope,
      source: row.source,
      lifecycle: row.lifecycle,
    });
    await writeEvent(tx, {
      tenant_id: p.tenant_id,
      channel: "skill.lifecycle",
      type: "skill.created",
      payload: {
        skill_id: row.id,
        actor_id: p.actor_id ?? null,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

export interface ListSkillsParams {
  tenant_id: string;
  scope?: SkillScope;
  connector_id?: string;
  workflow_id?: string;
  status?: SkillLifecycle;
  q?: string;
  sort?: "title" | "scope" | "status" | "version" | "updated_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function listSkills(p: ListSkillsParams, exec?: Executor): Promise<Skill[]> {
  const db = exec ?? getDb();
  const tenantConds = [eq(skills.tenant_id, p.tenant_id)];
  if (p.scope) tenantConds.push(eq(skills.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skills.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skills.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(skills.lifecycle, p.status));
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(skills.title, needle),
      ilike(skills.slug, needle),
      ilike(skills.body, needle),
    );
    if (search) tenantConds.push(search);
  }
  const sortColumn =
    p.sort === "title"
      ? skills.title
      : p.sort === "scope"
        ? skills.scope
        : p.sort === "status"
          ? skills.lifecycle
          : p.sort === "updated_at"
            ? skills.updated_at
            : skills.version;
  const ordered = p.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const rows = await db
    .select()
    .from(skills)
    .where(and(...tenantConds))
    .orderBy(ordered, asc(skills.id))
    .limit(Math.min(p.limit ?? 100, 500))
    .offset(p.offset ?? 0);
  return rows.map(rowToSkill);
}

export async function countSkills(
  p: Omit<ListSkillsParams, "limit" | "offset" | "sort" | "order">,
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  const tenantConds = [eq(skills.tenant_id, p.tenant_id)];
  if (p.scope) tenantConds.push(eq(skills.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skills.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skills.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(skills.lifecycle, p.status));
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(skills.title, needle),
      ilike(skills.slug, needle),
      ilike(skills.body, needle),
    );
    if (search) tenantConds.push(search);
  }
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(skills)
    .where(and(...tenantConds));
  return Number(row?.total ?? 0);
}

export async function getSkill(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<Skill | null> {
  // skills.id is uuid; passing a non-UUID makes Postgres throw before we
  // can return null. Callers that have only a slug must use getSkillBySlug.
  if (!UUID_RE.test(id)) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? rowToSkill(row) : null;
}

export async function getSkillBySlug(
  tenant_id: string,
  slug: string,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, slug)))
    .limit(1);
  const row = rows[0];
  return row ? rowToSkill(row) : null;
}

export async function updateSkill(
  tenant_id: string,
  id: string,
  patch: UpdateSkillInput,
  actor_id: string | null,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .for("update")
      .limit(1);
    const prior = existingRows[0];
    if (!prior) return null;
    if (patch.expected_version !== undefined && patch.expected_version !== prior.version) {
      throw new ConflictError("skill version changed", {
        expected_version: patch.expected_version,
        current_version: prior.version,
      });
    }
    const priorBlob = blobToFields(prior.examples);
    const nextBlob: SkillExamplesBlob = {
      examples: patch.examples ?? priorBlob.examples,
      best_practices: patch.best_practices ?? priorBlob.best_practices,
      pitfalls: patch.pitfalls ?? priorBlob.pitfalls,
      doc_refs: patch.doc_refs ?? priorBlob.doc_refs,
    };
    const set: Partial<typeof skills.$inferInsert> = {
      version: prior.version + 1,
      updated_at: new Date(),
      examples: nextBlob,
    };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.status !== undefined) set.lifecycle = patch.status;
    if (patch.gates_tools !== undefined) set.gates_tools = patch.gates_tools;
    if (patch.activates_when !== undefined) set.activates_when = patch.activates_when;
    if (patch.input_schema !== undefined) set.input_schema = patch.input_schema;
    if (patch.output_schema !== undefined) set.output_schema = patch.output_schema;
    if (patch.side_effects !== undefined) set.side_effects = patch.side_effects;
    if (patch.idempotency !== undefined) set.idempotency = patch.idempotency;
    if (patch.maturity !== undefined) set.maturity = patch.maturity;
    if (patch.tags !== undefined) set.tags = patch.tags;
    const [row] = await tx.update(skills).set(set).where(eq(skills.id, id)).returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SKILL_UPDATED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        // Full serialized skill view (the GET-route shape) so the audit
        // trail doubles as restorable version history — see restoreSkill.
        before: rowToSkill(prior),
        after: rowToSkill(row),
        metadata: {},
      },
      tx,
    );
    log.skill.updated({
      skill_id: id,
      tenant_id,
      version: row.version,
      actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.updated",
      payload: {
        skill_id: id,
        actor_id,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

export async function activateSkill(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .limit(1);
    const prior = existing[0];
    if (!prior) return null;
    if (prior.lifecycle === "active") return rowToSkill(prior);
    const [row] = await tx
      .update(skills)
      .set({ lifecycle: "active", version: prior.version + 1, updated_at: new Date() })
      .where(eq(skills.id, id))
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SKILL_ACTIVATED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        metadata: { from: prior.lifecycle },
      },
      tx,
    );
    log.skill.lifecycle({
      skill_id: id,
      tenant_id,
      from: prior.lifecycle,
      to: "active",
      actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.activated",
      payload: {
        skill_id: id,
        actor_id,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

export async function archiveSkill(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .limit(1);
    const prior = existing[0];
    if (!prior) return null;
    if (prior.lifecycle === "archived") return rowToSkill(prior);
    const [row] = await tx
      .update(skills)
      .set({ lifecycle: "archived", version: prior.version + 1, updated_at: new Date() })
      .where(eq(skills.id, id))
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SKILL_ARCHIVED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        metadata: { from: prior.lifecycle },
      },
      tx,
    );
    log.skill.lifecycle({
      skill_id: id,
      tenant_id,
      from: prior.lifecycle,
      to: "archived",
      actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.archived",
      payload: {
        skill_id: id,
        actor_id,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

export async function deleteSkill(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  // Docs say archive replaces deletion for operator-facing flows, but the
  // route surface requires a DELETE for parity. A DELETE hard-deletes the
  // row and writes an audit trail — operators should prefer archive.
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .limit(1);
    if (!existing[0]) return false;
    await tx.delete(skills).where(eq(skills.id, id));
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SKILL_DELETED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        reason: "hard_delete",
        metadata: {},
      },
      tx,
    );
    log.skill.deleted({
      skill_id: id,
      tenant_id,
      actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.deleted",
      payload: {
        skill_id: id,
        actor_id,
      },
    });
    return true;
  });
}

// ---- version history (read-time aggregation over audit_log) ---------------

export interface SkillHistoryEntry {
  audit_entry_id: string;
  version: number | null;
  title: string | null;
  lifecycle: string | null;
  updated_at: string;
  actor_id: string | null;
  /** False for `skill.updated` rows written before snapshots were widened
   *  to the full skill view — those entries are not restorable. */
  has_snapshot: boolean;
}

const MAX_HISTORY_ROWS = 500;

function snapshotFromAudit(value: unknown): Skill | null {
  const parsed = SkillSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listSkillHistory(
  tenant_id: string,
  skill_id: string,
  exec?: Executor,
): Promise<SkillHistoryEntry[]> {
  const db = exec ?? getDb();
  const tenantConds = [
    eq(auditLog.tenant_id, tenant_id),
    eq(auditLog.action, AuditAction.SKILL_UPDATED),
    eq(auditLog.resource_type, "skill"),
    eq(auditLog.resource_id, skill_id),
  ];
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...tenantConds))
    .orderBy(desc(auditLog.ts))
    .limit(MAX_HISTORY_ROWS);
  return rows.map((row) => {
    const snapshot = snapshotFromAudit(row.after);
    // Pre-snapshot rows carry the legacy thin {lifecycle, version, title}
    // shape — surface those fields so the history view stays readable.
    const thin = (row.after ?? {}) as { lifecycle?: unknown; version?: unknown; title?: unknown };
    return {
      audit_entry_id: row.id,
      version: snapshot?.version ?? (typeof thin.version === "number" ? thin.version : null),
      title: snapshot?.title ?? (typeof thin.title === "string" ? thin.title : null),
      lifecycle: snapshot?.status ?? (typeof thin.lifecycle === "string" ? thin.lifecycle : null),
      updated_at: row.ts.toISOString(),
      actor_id: row.actor_id,
      has_snapshot: snapshot !== null,
    };
  });
}

/**
 * Restores a skill to the `after` snapshot of a prior `skill.updated`
 * audit entry. Delegates the write to `updateSkill`, so the restore
 * itself bumps `version` and lands its own audit row + snapshot.
 */
export async function restoreSkill(
  tenant_id: string,
  id: string,
  audit_entry_id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.id, audit_entry_id)))
    .limit(1);
  const entry = rows[0];
  if (!entry) throw new NotFoundError("audit entry");
  if (entry.action !== AuditAction.SKILL_UPDATED || entry.resource_id !== id) {
    throw HttpError.withEnvelope(
      409,
      "conflict",
      "audit entry does not reference an update of this skill",
      { hint: `Pick an audit_entry_id from GET /v1/skills/${id}/history.` },
    );
  }
  const snapshot = snapshotFromAudit(entry.after);
  if (!snapshot) {
    throw HttpError.withEnvelope(
      409,
      "conflict",
      "audit entry predates full skill snapshots and cannot be restored",
      { hint: `Pick a history entry with has_snapshot=true from GET /v1/skills/${id}/history.` },
    );
  }
  return await updateSkill(
    tenant_id,
    id,
    {
      title: snapshot.title,
      body: snapshot.body,
      examples: snapshot.examples,
      best_practices: snapshot.best_practices,
      pitfalls: snapshot.pitfalls,
      doc_refs: snapshot.doc_refs,
      gates_tools: snapshot.gates_tools,
      activates_when: snapshot.activates_when,
      input_schema: snapshot.input_schema,
      output_schema: snapshot.output_schema,
      side_effects: snapshot.side_effects,
      idempotency: snapshot.idempotency,
      maturity: snapshot.maturity,
      tags: snapshot.tags,
      status: snapshot.status,
    },
    actor_id,
    db,
  );
}

// ---- retrieval helpers (used by Context Enhancement) ----------------------

export interface RetrieveApplicableParams {
  tenant_id: string;
  connector_ids?: string[];
  workflow_ids?: string[];
}

/**
 * Returns the active skills applicable to the given scope selectors, in
 * scope order (global → connector → workflow). Within each scope rows
 * are ordered by descending version. The ordering is deterministic —
 * the same inputs yield the same prompt section every time.
 */
export async function retrieveApplicableSkills(
  p: RetrieveApplicableParams,
  exec?: Executor,
): Promise<Skill[]> {
  const db = exec ?? getDb();
  const active = eq(skills.lifecycle, "active");
  const tenant = eq(skills.tenant_id, p.tenant_id);

  const globalRows = await db
    .select()
    .from(skills)
    .where(and(tenant, active, eq(skills.scope, "global")))
    .orderBy(desc(skills.version), desc(skills.created_at));

  let connectorRows: SkillRow[] = [];
  if (p.connector_ids && p.connector_ids.length > 0) {
    connectorRows = await db
      .select()
      .from(skills)
      .where(
        and(
          tenant,
          active,
          eq(skills.scope, "connector"),
          inArray(skills.connector_id, p.connector_ids),
        ),
      )
      .orderBy(desc(skills.version), desc(skills.created_at));
  }

  let workflowRows: SkillRow[] = [];
  if (p.workflow_ids && p.workflow_ids.length > 0) {
    workflowRows = await db
      .select()
      .from(skills)
      .where(
        and(
          tenant,
          active,
          eq(skills.scope, "workflow"),
          inArray(skills.workflow_id, p.workflow_ids),
        ),
      )
      .orderBy(desc(skills.version), desc(skills.created_at));
  }

  return [...globalRows, ...connectorRows, ...workflowRows].map(rowToSkill);
}

/**
 * Returns active stable skills whose `activates_when` rules contain
 * either a `kind:"baseline"` rule or a `kind:"intent_keyword"` rule
 * matching any of the supplied keywords (case-insensitive substring
 * via lowercased equality on the configured `word`).
 *
 * Used by `apps/engine/src/llm/core/context-assembler.ts` to surface
 * topical skills into the assembled prompt based on the user's intent
 * vocabulary on the current turn. `maturity:"experimental"` skills are
 * excluded — they are only reachable via explicit `load_skill(slug)`.
 */
export async function listAutoLoadSkills(
  tenant_id: string,
  keywords: string[],
  exec?: Executor,
): Promise<Skill[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.lifecycle, "active")))
    .orderBy(desc(skills.version), desc(skills.created_at));
  const keySet = new Set(keywords.map((k) => k.toLowerCase()));
  return rows
    .filter((row) => {
      if (row.maturity === "experimental") return false;
      const acts = Array.isArray(row.activates_when) ? row.activates_when : [];
      for (const rule of acts) {
        if (!rule || typeof rule !== "object") continue;
        const r = rule as { kind?: string; word?: string };
        if (r.kind === "baseline") return true;
        if (r.kind === "intent_keyword" && typeof r.word === "string") {
          if (keySet.has(r.word.toLowerCase())) return true;
        }
      }
      return false;
    })
    .map(rowToSkill);
}

// Touch isNull + sql so the biome unused-import pass does not reject them
// if a future edit removes a call site.
void isNull;
void sql;
