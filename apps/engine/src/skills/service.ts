import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type CatalogGroupBy,
  catalogMetadataView,
  humanMetadataWrite,
  metadataChange,
} from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import type { AuditActorType } from "../audit/types.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { catalogGroupOrder } from "../db/list-result.ts";
import { auditLog, skillCandidates, skills } from "../db/schema/index.ts";
import { ConflictError } from "../http/errors.ts";
import { log } from "../logging/index.ts";
import { isUuid } from "../utils/index.ts";
import { skillExamplesFromBlob } from "./examples-blob.ts";
import {
  type CreateSkillInput,
  type Skill,
  type SkillAudience,
  type SkillExamplesBlob,
  type SkillLifecycle,
  type SkillRule,
  SkillSchema,
  type SkillScope,
  type SkillSource,
  skillOfferedTo,
  skillScopeViolation,
  type UpdateSkillInput,
} from "./types.ts";

type SkillRow = typeof skills.$inferSelect;

function resolveSkillActor(
  actor_id: string | null,
  actor_type?: AuditActorType,
): { actor_id: string | null; actor_type: AuditActorType } {
  if (actor_type === "system") return { actor_type, actor_id: null };
  if (actor_type === "unknown" || (!actor_type && actor_id) || (actor_type && !actor_id)) {
    return { actor_type: "unknown", actor_id: null };
  }
  if (actor_type) return { actor_type, actor_id };
  return { actor_type: "system", actor_id: null };
}

function rowToSkill(row: SkillRow): Skill {
  const fields = skillExamplesFromBlob(row.examples);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope: row.scope as SkillScope,
    connector_id: row.connector_id ?? null,
    workflow_id: row.workflow_id ?? null,
    slug: row.slug ?? null,
    title: row.title,
    ...catalogMetadataView(row),
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
    applies_to: row.applies_to,
    audience: Array.isArray(row.audience) ? row.audience : [],
    rules: Array.isArray(row.rules) ? row.rules : [],
    domains: Array.isArray(row.domains) ? row.domains : [],
    status: row.lifecycle as SkillLifecycle,
    source: row.source as SkillSource,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function validateScope(input: Parameters<typeof skillScopeViolation>[0]): void {
  const violation = skillScopeViolation(input);
  if (violation) throw new Error(violation);
}

export interface SkillConventionsWrite {
  rules?: SkillRule[] | undefined;
  domains?: string[] | undefined;
}

interface CreateSkillParams {
  tenant_id: string;
  input: CreateSkillInput;
  actor_id?: string | null;
  actor_type?: AuditActorType;
  conventions?: SkillConventionsWrite;
  slug?: string;
}

export async function createSkill(p: CreateSkillParams, db: Executor): Promise<Skill> {
  const actor = resolveSkillActor(p.actor_id ?? null, p.actor_type);
  validateScope(p.input);
  const blob: SkillExamplesBlob = {
    examples: p.input.examples ?? [],
    best_practices: p.input.best_practices ?? [],
    pitfalls: p.input.pitfalls ?? [],
    doc_refs: p.input.doc_refs ?? [],
  };
  return await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    const inserted = await tx
      .insert(skills)
      .values({
        tenant_id: p.tenant_id,
        ...(p.slug !== undefined ? { slug: p.slug } : {}),
        scope: p.input.scope,
        connector_id: p.input.connector_id ?? null,
        workflow_id: p.input.workflow_id ?? null,
        title: p.input.title,
        ...humanMetadataWrite({
          ...(p.input.description !== undefined ? { description: p.input.description } : {}),
          ...(p.input.category !== undefined ? { category: p.input.category } : {}),
        }),
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
        applies_to: p.input.applies_to ?? "both",
        audience: p.input.audience ?? [],
        rules: p.conventions?.rules ?? [],
        domains: p.conventions?.domains ?? [],
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "skills");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actor,
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
        actor_id: actor.actor_id,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

interface ListSkillsParams {
  description_source?: "llm" | "human";
  tenant_id: string;
  scope?: SkillScope;
  connector_id?: string;
  workflow_id?: string;
  status?: SkillLifecycle;
  category?: string;
  q?: string;
  sort?: "title" | "scope" | "status" | "version" | "updated_at";
  group_by?: CatalogGroupBy;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function listSkills(p: ListSkillsParams, db: Executor): Promise<Skill[]> {
  const tenantConds = [eq(skills.tenant_id, p.tenant_id)];
  if (p.scope) tenantConds.push(eq(skills.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skills.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skills.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(skills.lifecycle, p.status));
  if (p.category) tenantConds.push(eq(skills.category, p.category));
  if (p.description_source) tenantConds.push(eq(skills.description_source, p.description_source));
  if (p.description_source === "llm")
    tenantConds.push(sql`length(trim(coalesce(${skills.description}, ''))) > 0`);
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(skills.title, needle),
      ilike(skills.slug, needle),
      ilike(skills.description, needle),
      ilike(skills.category, needle),
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
    .orderBy(...catalogGroupOrder(p.group_by, skills.category), ordered, asc(skills.id))
    .limit(Math.min(p.limit ?? 100, 500))
    .offset(p.offset ?? 0);
  return rows.map(rowToSkill);
}

export async function countSkills(
  p: Omit<ListSkillsParams, "limit" | "offset" | "sort" | "order">,
  db: Executor,
): Promise<number> {
  const tenantConds = [eq(skills.tenant_id, p.tenant_id)];
  if (p.scope) tenantConds.push(eq(skills.scope, p.scope));
  if (p.connector_id) tenantConds.push(eq(skills.connector_id, p.connector_id));
  if (p.workflow_id) tenantConds.push(eq(skills.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(skills.lifecycle, p.status));
  if (p.category) tenantConds.push(eq(skills.category, p.category));
  if (p.description_source) tenantConds.push(eq(skills.description_source, p.description_source));
  if (p.description_source === "llm")
    tenantConds.push(sql`length(trim(coalesce(${skills.description}, ''))) > 0`);
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(skills.title, needle),
      ilike(skills.slug, needle),
      ilike(skills.description, needle),
      ilike(skills.category, needle),
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

export async function getSkill(tenant_id: string, id: string, db: Executor): Promise<Skill | null> {
  if (!isUuid(id)) return null;
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
  db: Executor,
): Promise<Skill | null> {
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
  db: Executor,
  actor_type?: AuditActorType,
  conventions?: SkillConventionsWrite,
): Promise<Skill | null> {
  const actor = resolveSkillActor(actor_id, actor_type);
  return await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
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
    const priorBlob = skillExamplesFromBlob(prior.examples);
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
    if (patch.applies_to !== undefined) set.applies_to = patch.applies_to;
    if (patch.audience !== undefined) set.audience = patch.audience;
    if (conventions?.rules !== undefined) set.rules = conventions.rules;
    if (conventions?.domains !== undefined) set.domains = conventions.domains;
    Object.assign(
      set,
      metadataChange(prior, {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.accept_description !== undefined
          ? { accept_description: patch.accept_description }
          : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
      }),
    );
    const [row] = await tx.update(skills).set(set).where(eq(skills.id, id)).returning();
    if (!row) return null;
    const retired =
      prior.lifecycle !== "active" && row.lifecycle === "active"
        ? await retireReplacedConnectorSkills(tx, tenant_id, id, actor.actor_id, actor.actor_type)
        : [];
    await auditAwait(
      {
        tenant_id,
        ...actor,
        action: AuditAction.SKILL_UPDATED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        before: rowToSkill(prior),
        after: rowToSkill(row),
        metadata: retired.length > 0 ? { retired_skill_ids: retired } : {},
      },
      tx,
    );
    log.skill.updated({
      skill_id: id,
      tenant_id,
      version: row.version,
      actor_id: actor.actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.updated",
      payload: {
        skill_id: id,
        actor_id: actor.actor_id,
        lifecycle: row.lifecycle,
        title: row.title,
      },
    });
    return rowToSkill(row);
  });
}

export async function retireReplacedConnectorSkills(
  tx: Executor,
  tenant_id: string,
  skill_id: string,
  actor_id: string | null,
  actor_type?: AuditActorType,
): Promise<string[]> {
  const [lineage] = await tx
    .select({ connector_id: skillCandidates.connector_id })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.tenant_id, tenant_id),
        eq(skillCandidates.promoted_skill_id, skill_id),
        eq(skillCandidates.pattern_kind, "connector_capability"),
      ),
    )
    .limit(1);
  if (!lineage?.connector_id) return [];
  const replaced = await tx
    .select({ id: skills.id })
    .from(skillCandidates)
    .innerJoin(skills, eq(skills.id, skillCandidates.promoted_skill_id))
    .where(
      and(
        eq(skillCandidates.tenant_id, tenant_id),
        eq(skillCandidates.pattern_kind, "connector_capability"),
        eq(skillCandidates.connector_id, lineage.connector_id),
        eq(skillCandidates.status, "approved"),
        sql`${skillCandidates.promoted_skill_id} <> ${skill_id}`,
        eq(skills.tenant_id, tenant_id),
        eq(skills.lifecycle, "active"),
      ),
    );
  const retired: string[] = [];
  for (const r of replaced) {
    if (await archiveSkill(tenant_id, r.id, actor_id, tx, actor_type)) retired.push(r.id);
  }
  return retired;
}

export async function activateSkill(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  db: Executor,
  actor_type?: AuditActorType,
): Promise<Skill | null> {
  const actor = resolveSkillActor(actor_id, actor_type);
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
    const retired = await retireReplacedConnectorSkills(
      tx,
      tenant_id,
      id,
      actor.actor_id,
      actor.actor_type,
    );
    await auditAwait(
      {
        tenant_id,
        ...actor,
        action: AuditAction.SKILL_ACTIVATED,
        resource_type: "skill",
        resource_id: id,
        result: "success",
        metadata: {
          from: prior.lifecycle,
          ...(retired.length > 0 ? { retired_skill_ids: retired } : {}),
        },
      },
      tx,
    );
    log.skill.lifecycle({
      skill_id: id,
      tenant_id,
      from: prior.lifecycle,
      to: "active",
      actor_id: actor.actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.activated",
      payload: {
        skill_id: id,
        actor_id: actor.actor_id,
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
  db: Executor,
  actor_type?: AuditActorType,
): Promise<Skill | null> {
  const actor = resolveSkillActor(actor_id, actor_type);
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
        ...actor,
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
      actor_id: actor.actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.archived",
      payload: {
        skill_id: id,
        actor_id: actor.actor_id,
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
  db: Executor,
  actor_type?: AuditActorType,
): Promise<boolean> {
  const actor = resolveSkillActor(actor_id, actor_type);
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
        ...actor,
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
      actor_id: actor.actor_id,
    });
    await writeEvent(tx, {
      tenant_id,
      channel: "skill.lifecycle",
      type: "skill.deleted",
      payload: {
        skill_id: id,
        actor_id: actor.actor_id,
      },
    });
    return true;
  });
}

export interface SkillHistoryEntry {
  audit_entry_id: string;
  version: number | null;
  title: string | null;
  lifecycle: string | null;
  updated_at: string;
  actor_id: string | null;
  has_snapshot: boolean;
}

const MAX_HISTORY_ROWS = 500;

function snapshotFromAudit(value: unknown): Skill | null {
  const parsed = SkillSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function historyEntry(row: typeof auditLog.$inferSelect): SkillHistoryEntry {
  const snapshot = snapshotFromAudit(row.after);
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
}

export async function listSkillHistory(
  tenant_id: string,
  skill_id: string,
  db: Executor,
): Promise<SkillHistoryEntry[]> {
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
  return rows.map(historyEntry);
}

export interface SkillHistoryState {
  title: string;
  body: string;
}

export interface SkillHistoryDetail extends SkillHistoryEntry {
  before: SkillHistoryState | null;
  after: SkillHistoryState | null;
}

function historyState(value: unknown): SkillHistoryState | null {
  const snapshot = snapshotFromAudit(value);
  return snapshot ? { title: snapshot.title, body: snapshot.body } : null;
}

export async function getSkillHistoryEntry(
  tenant_id: string,
  skill_id: string,
  audit_entry_id: string,
  db: Executor,
): Promise<SkillHistoryDetail | null> {
  const tenantConds = [
    eq(auditLog.tenant_id, tenant_id),
    eq(auditLog.id, audit_entry_id),
    eq(auditLog.action, AuditAction.SKILL_UPDATED),
    eq(auditLog.resource_type, "skill"),
    eq(auditLog.resource_id, skill_id),
  ];
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...tenantConds))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...historyEntry(row),
    before: historyState(row.before),
    after: historyState(row.after),
  };
}

export type RestoreSkillRejection =
  | "audit_entry_not_found"
  | "audit_entry_not_a_skill_update"
  | "audit_entry_without_snapshot";

export type RestoreSkillOutcome =
  | { readonly ok: true; readonly skill: Skill | null }
  | { readonly ok: false; readonly rejection: RestoreSkillRejection };

export async function restoreSkill(
  tenant_id: string,
  id: string,
  audit_entry_id: string,
  actor_id: string | null,
  db: Executor,
  actor_type?: AuditActorType,
): Promise<RestoreSkillOutcome> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.id, audit_entry_id)))
    .limit(1);
  const entry = rows[0];
  if (!entry) return { ok: false, rejection: "audit_entry_not_found" };
  if (entry.action !== AuditAction.SKILL_UPDATED || entry.resource_id !== id)
    return { ok: false, rejection: "audit_entry_not_a_skill_update" };
  const snapshot = snapshotFromAudit(entry.after);
  if (!snapshot) return { ok: false, rejection: "audit_entry_without_snapshot" };
  const skill = await updateSkill(
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
      applies_to: snapshot.applies_to,
      audience: snapshot.audience,
      status: snapshot.status,
    },
    actor_id,
    db,
    actor_type,
  );
  return { ok: true, skill };
}

interface RetrieveApplicableParams {
  tenant_id: string;
  connector_ids?: string[];
  workflow_ids?: string[];
  audience?: SkillAudience;
  include_template_bound?: boolean;
}

export async function retrieveApplicableSkills(
  p: RetrieveApplicableParams,
  db: Executor,
): Promise<Skill[]> {
  const active = eq(skills.lifecycle, "active");
  const tenant = eq(skills.tenant_id, p.tenant_id);

  const globalRows = await db
    .select()
    .from(skills)
    .where(and(tenant, active, eq(skills.scope, "global")))
    .orderBy(desc(skills.version), desc(skills.created_at));

  const templateBoundRows = p.include_template_bound
    ? await db
        .select()
        .from(skills)
        .where(and(tenant, active, eq(skills.scope, "connector"), isNull(skills.connector_id)))
        .orderBy(desc(skills.version), desc(skills.created_at))
    : [];

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

  const all = [...globalRows, ...templateBoundRows, ...connectorRows, ...workflowRows].map(
    rowToSkill,
  );
  const audience = p.audience;
  return audience ? all.filter((s) => skillOfferedTo(s.applies_to, audience)) : all;
}

export async function listAutoLoadSkills(
  tenant_id: string,
  keywords: string[],
  db: Executor,
): Promise<Skill[]> {
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

void isNull;
void sql;
