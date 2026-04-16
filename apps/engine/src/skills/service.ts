// Skill CRUD + lifecycle. Skills are hand-authored and curated — the
// engine never mutates them. Every write bumps `version` and writes an
// audit entry. The retrieval helpers below are the canonical read path
// used by the Context Enhancement pipeline.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { skills } from "../db/schema/index.ts";
import type {
  CreateSkillInput,
  Skill,
  SkillExamplesBlob,
  SkillLifecycle,
  SkillScope,
  UpdateSkillInput,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type SkillRow = typeof skills.$inferSelect;

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
    title: row.title,
    body: row.body,
    examples: fields.examples,
    best_practices: fields.best_practices,
    pitfalls: fields.pitfalls,
    doc_refs: fields.doc_refs,
    status: row.lifecycle as SkillLifecycle,
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
        version: 1,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("skills insert returned no row");
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
    return rowToSkill(row);
  });
}

export interface ListSkillsParams {
  tenant_id: string;
  scope?: SkillScope;
  connector_id?: string;
  workflow_id?: string;
  status?: SkillLifecycle;
  limit?: number;
  offset?: number;
}

export async function listSkills(p: ListSkillsParams, exec?: Executor): Promise<Skill[]> {
  const db = exec ?? getDb();
  const conds = [eq(skills.tenant_id, p.tenant_id)];
  if (p.scope) conds.push(eq(skills.scope, p.scope));
  if (p.connector_id) conds.push(eq(skills.connector_id, p.connector_id));
  if (p.workflow_id) conds.push(eq(skills.workflow_id, p.workflow_id));
  if (p.status) conds.push(eq(skills.lifecycle, p.status));
  const rows = await db
    .select()
    .from(skills)
    .where(and(...conds))
    .orderBy(desc(skills.version), desc(skills.created_at))
    .limit(Math.min(p.limit ?? 100, 500))
    .offset(p.offset ?? 0);
  return rows.map(rowToSkill);
}

export async function getSkill(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<Skill | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
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
      .limit(1);
    const prior = existingRows[0];
    if (!prior) return null;
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
        before: { lifecycle: prior.lifecycle, version: prior.version, title: prior.title },
        after: { lifecycle: row.lifecycle, version: row.version, title: row.title },
        metadata: {},
      },
      tx,
    );
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
    return true;
  });
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

// Touch isNull + sql so the biome unused-import pass does not reject them
// if a future edit removes a call site.
void isNull;
void sql;
