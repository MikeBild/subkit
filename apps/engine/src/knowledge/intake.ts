import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { CategorySchema } from "../api/catalog-metadata.ts";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import {
  type IntakeProposalTarget,
  type IntakeSnapshot,
  intakeCategoryDefaults,
  intakeItems,
  intakeProposalItems,
  intakeProposalRevisions,
  intakeProposals,
} from "../db/schema/intake.ts";
import { parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import { getKnowledgeSourceContent } from "./content.ts";
import { proposalDigest, requestDigest } from "./intake-digest.ts";
import {
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "./intake-errors.ts";
import type {
  ConfirmIntakeProposalParams,
  CreateIntakeItemParams,
  CreateIntakeProposalParams,
  IntakeCategoryView,
  IntakeItemView,
  IntakeProposalItemView,
  IntakeProposalRevisionView,
  IntakeProposalView,
  PatchIntakeItemParams,
  ReviseIntakeProposalParams,
  SetIntakeDefaultCategoryParams,
} from "./intake-types.ts";
import {
  applyKnowledgeCreate,
  applyKnowledgeIngest,
  finishKnowledgeWrite,
  prepareKnowledgeCreate,
  prepareKnowledgeIngest,
} from "./service.ts";
import type { CreateKnowledgeSourceParams, IngestKnowledgeSourceParams } from "./types.ts";

const DEFAULT_CATEGORY = "inbox";

function category(value: string): string {
  return CategorySchema.parse(value);
}

function actorFromColumns(kind: string, id: string): Actor {
  return { kind: kind === "user" ? "user" : "system_account", id };
}

function itemView(row: typeof intakeItems.$inferSelect): IntakeItemView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    category: row.category,
    client_request_id: row.client_request_id,
    original_snapshot: row.original_snapshot,
    title: row.title,
    body: row.body,
    note: row.note,
    state: row.state,
    version: row.version,
    collected_by: actorFromColumns(row.collected_by_type, row.collected_by_id),
    admitted_knowledge_source_id: row.admitted_knowledge_source_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function snapshot(p: CreateIntakeItemParams): IntakeSnapshot {
  const source = p.original_snapshot;
  return {
    title: source?.title ?? p.title,
    source_url: source?.source_url ?? p.source_url,
    ...((source?.source_author ?? p.source_author)
      ? { source_author: source?.source_author ?? p.source_author }
      : {}),
    ...((source?.published_at ?? p.published_at)
      ? { published_at: source?.published_at ?? p.published_at }
      : {}),
    captured_at: source?.captured_at ?? p.captured_at,
    body: source?.body ?? p.body,
    origin: source?.origin ?? "capture",
  };
}

function itemRequestDigest(p: CreateIntakeItemParams, intakeCategory: string): string {
  return requestDigest({
    actor: p.actor,
    category: intakeCategory,
    title: p.title,
    source_url: p.source_url,
    source_author: p.source_author ?? null,
    published_at: p.published_at ?? null,
    captured_at: p.captured_at,
    body: p.body,
    note: p.note ?? "",
    original_snapshot: snapshot(p),
  });
}

async function audit(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
  action: (typeof AuditAction)[keyof typeof AuditAction],
  resource_type: string,
  resource_id: string,
  metadata: Record<string, unknown> = {},
) {
  await auditAwait(
    {
      tenant_id,
      ...auditActor(actor),
      action,
      resource_type,
      resource_id,
      result: "success",
      metadata,
    },
    tx,
  );
}

async function defaultCategory(tx: Executor, tenant_id: string, actor: Actor): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant_id}:${actor.kind}:${actor.id}`}))`,
  );
  const rows = await tx
    .select()
    .from(intakeCategoryDefaults)
    .where(
      and(
        eq(intakeCategoryDefaults.tenant_id, tenant_id),
        eq(intakeCategoryDefaults.actor_type, actor.kind),
        eq(intakeCategoryDefaults.actor_id, actor.id),
      ),
    )
    .limit(1)
    .for("update");
  if (rows[0]) return rows[0].category;
  await tx
    .insert(intakeCategoryDefaults)
    .values({ tenant_id, actor_type: actor.kind, actor_id: actor.id, category: DEFAULT_CATEGORY })
    .onConflictDoNothing();
  return (
    (
      await tx
        .select({ category: intakeCategoryDefaults.category })
        .from(intakeCategoryDefaults)
        .where(
          and(
            eq(intakeCategoryDefaults.tenant_id, tenant_id),
            eq(intakeCategoryDefaults.actor_type, actor.kind),
            eq(intakeCategoryDefaults.actor_id, actor.id),
          ),
        )
        .limit(1)
    )[0]?.category ?? DEFAULT_CATEGORY
  );
}

export async function listIntakeCategories(
  p: { tenant_id: string; actor: Actor },
  exec?: Executor,
): Promise<{ items: IntakeCategoryView[]; default_category: string }> {
  const db = exec ?? getDb();
  const defaults = await db
    .select({ category: intakeCategoryDefaults.category })
    .from(intakeCategoryDefaults)
    .where(
      and(
        eq(intakeCategoryDefaults.tenant_id, p.tenant_id),
        eq(intakeCategoryDefaults.actor_type, p.actor.kind),
        eq(intakeCategoryDefaults.actor_id, p.actor.id),
      ),
    )
    .limit(1);
  const default_category = defaults[0]?.category ?? DEFAULT_CATEGORY;
  const rows = await db
    .select({
      category: intakeItems.category,
      collected: sql<number>`count(*) FILTER (WHERE ${intakeItems.state} = 'collected')::int`,
      reviewing: sql<number>`count(*) FILTER (WHERE ${intakeItems.state} = 'reviewing')::int`,
    })
    .from(intakeItems)
    .where(eq(intakeItems.tenant_id, p.tenant_id))
    .groupBy(intakeItems.category)
    .orderBy(asc(intakeItems.category));
  const items = rows.map((row) => ({ ...row, is_default: row.category === default_category }));
  if (!items.some((item) => item.category === default_category))
    items.unshift({ category: default_category, collected: 0, reviewing: 0, is_default: true });
  return { items, default_category };
}

export async function setIntakeDefaultCategory(
  p: SetIntakeDefaultCategoryParams,
  exec?: Executor,
): Promise<{ category: string }> {
  const db = exec ?? getDb();
  const intakeCategory = category(p.category);
  return (db as Db).transaction(async (tx) => {
    await tx
      .insert(intakeCategoryDefaults)
      .values({
        tenant_id: p.tenant_id,
        actor_type: p.actor.kind,
        actor_id: p.actor.id,
        category: intakeCategory,
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          intakeCategoryDefaults.tenant_id,
          intakeCategoryDefaults.actor_type,
          intakeCategoryDefaults.actor_id,
        ],
        set: { category: intakeCategory, updated_at: new Date() },
      });
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_DEFAULT_CATEGORY_UPDATED,
      "intake_category_default",
      `${p.actor.kind}:${p.actor.id}`,
      { category: intakeCategory },
    );
    return { category: intakeCategory };
  });
}

export async function createIntakeItem(
  p: CreateIntakeItemParams,
  exec?: Executor,
): Promise<IntakeItemView> {
  const db = exec ?? getDb();
  return (db as Db).transaction(async (tx) => {
    const intakeCategory = p.category
      ? category(p.category)
      : await defaultCategory(tx, p.tenant_id, p.actor);
    const digest = itemRequestDigest(p, intakeCategory);
    const previous = await tx
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          eq(intakeItems.client_request_id, p.client_request_id),
        ),
      )
      .limit(1);
    if (previous[0]) {
      if (previous[0].creation_request_digest !== digest)
        throw new IntakeConflictError("item request id was already used with different content");
      return itemView(previous[0]);
    }
    const inserted = await tx
      .insert(intakeItems)
      .values({
        tenant_id: p.tenant_id,
        category: intakeCategory,
        client_request_id: p.client_request_id,
        creation_request_digest: digest,
        original_snapshot: snapshot(p),
        title: p.title,
        body: p.body,
        note: p.note ?? "",
        collected_by_type: p.actor.kind,
        collected_by_id: p.actor.id,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted[0] ??
      (
        await tx
          .select()
          .from(intakeItems)
          .where(
            and(
              eq(intakeItems.tenant_id, p.tenant_id),
              eq(intakeItems.client_request_id, p.client_request_id),
            ),
          )
          .limit(1)
      )[0];
    if (!row) throw new Error("intake item insertion failed");
    if (!inserted[0]) {
      if (row.creation_request_digest !== digest)
        throw new IntakeConflictError("item request id was already used with different content");
      return itemView(row);
    }
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_ITEM_COLLECTED,
      "intake_item",
      row.id,
      { category: intakeCategory, source_url: row.original_snapshot.source_url },
    );
    return itemView(row);
  });
}

export async function listIntakeItems(
  p: {
    tenant_id: string;
    category?: string | undefined;
    state?: IntakeItemView["state"] | undefined;
  },
  exec?: Executor,
): Promise<IntakeItemView[]> {
  const db = exec ?? getDb();
  const tenantConds = [eq(intakeItems.tenant_id, p.tenant_id)];
  if (p.category) tenantConds.push(eq(intakeItems.category, category(p.category)));
  if (p.state) tenantConds.push(eq(intakeItems.state, p.state));
  return (
    await db
      .select()
      .from(intakeItems)
      .where(and(...tenantConds))
      .orderBy(desc(intakeItems.updated_at))
  ).map(itemView);
}

export async function getIntakeItem(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<IntakeItemView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenant_id), eq(intakeItems.id, id)))
    .limit(1);
  return rows[0] ? itemView(rows[0]) : null;
}

async function staleDraftProposalsForItems(
  tx: Executor,
  tenant_id: string,
  item_ids: readonly string[],
  reason: string,
): Promise<void> {
  if (!item_ids.length) return;
  const rows = await tx
    .select({ id: intakeProposals.id })
    .from(intakeProposals)
    .innerJoin(
      intakeProposalRevisions,
      and(
        eq(intakeProposalRevisions.proposal_id, intakeProposals.id),
        eq(intakeProposalRevisions.revision, intakeProposals.current_revision),
      ),
    )
    .innerJoin(
      intakeProposalItems,
      eq(intakeProposalItems.proposal_revision_id, intakeProposalRevisions.id),
    )
    .where(
      and(
        eq(intakeProposals.tenant_id, tenant_id),
        eq(intakeProposals.status, "draft"),
        inArray(intakeProposalItems.item_id, [...item_ids]),
      ),
    );
  const ids = [...new Set(rows.map((row) => row.id))];
  if (!ids.length) return;
  await tx
    .update(intakeProposals)
    .set({ status: "stale", stale_reason: reason, updated_at: new Date() })
    .where(and(eq(intakeProposals.tenant_id, tenant_id), inArray(intakeProposals.id, ids)));
}

export async function patchIntakeItem(
  p: PatchIntakeItemParams,
  exec?: Executor,
): Promise<IntakeItemView | null> {
  const db = exec ?? getDb();
  return (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, p.tenant_id), eq(intakeItems.id, p.id)))
      .limit(1)
      .for("update");
    const existing = rows[0];
    if (!existing) return null;
    if (existing.version !== p.expected_version)
      throw new IntakeConflictError("intake item has changed");
    if (existing.state === "admitted" && p.state !== undefined)
      throw new IntakeConflictError("an admitted intake item cannot change processing state");
    const contentChanged =
      p.title !== undefined ||
      p.body !== undefined ||
      p.note !== undefined ||
      p.category !== undefined ||
      p.state !== undefined;
    const [row] = await tx
      .update(intakeItems)
      .set({
        ...(p.category !== undefined ? { category: category(p.category) } : {}),
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
        ...(p.state !== undefined ? { state: p.state } : {}),
        ...(contentChanged ? { version: existing.version + 1 } : {}),
        updated_at: new Date(),
      })
      .where(and(eq(intakeItems.tenant_id, p.tenant_id), eq(intakeItems.id, p.id)))
      .returning();
    if (!row) throw new Error("intake item update failed");
    const staleReason =
      p.category !== undefined
        ? "intake_category_changed"
        : p.title !== undefined ||
            p.body !== undefined ||
            p.note !== undefined ||
            p.state !== undefined
          ? "intake_item_changed"
          : null;
    if (staleReason) await staleDraftProposalsForItems(tx, p.tenant_id, [p.id], staleReason);
    await audit(tx, p.tenant_id, p.actor, AuditAction.INTAKE_ITEM_UPDATED, "intake_item", p.id, {
      version: row.version,
      ...(p.category !== undefined ? { category: row.category } : {}),
    });
    return itemView(row);
  });
}

async function itemsForProposal(
  tx: Executor,
  tenant_id: string,
  item_ids: string[],
  expected_item_versions?: Record<string, number> | undefined,
): Promise<IntakeProposalItemView[]> {
  const unique = [...new Set(item_ids)];
  if (!unique.length) throw new IntakeConflictError("a proposal needs at least one intake item");
  const rows = await tx
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenant_id), inArray(intakeItems.id, unique)))
    .for("update");
  if (rows.length !== unique.length)
    throw new IntakeConflictError("a proposal item was not found in this tenant");
  if (rows.some((row) => row.state === "discarded" || row.state === "admitted"))
    throw new IntakeConflictError("discarded or admitted items cannot be proposed");
  if (
    expected_item_versions &&
    rows.some((row) => expected_item_versions[row.id] !== row.version)
  ) {
    throw new IntakeConflictError("an intake item changed after it was read");
  }
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    title: row.title,
    source_url: row.original_snapshot.source_url,
  }));
}

async function proposalRevision(
  tx: Executor,
  tenant_id: string,
  proposal_id: string,
  revision: number,
): Promise<IntakeProposalRevisionView | null> {
  const revisions = await tx
    .select()
    .from(intakeProposalRevisions)
    .where(
      and(
        eq(intakeProposalRevisions.tenant_id, tenant_id),
        eq(intakeProposalRevisions.proposal_id, proposal_id),
        eq(intakeProposalRevisions.revision, revision),
      ),
    )
    .limit(1);
  const row = revisions[0];
  if (!row) return null;
  const joined = await tx
    .select({ item: intakeItems, link: intakeProposalItems })
    .from(intakeProposalItems)
    .innerJoin(
      intakeItems,
      and(eq(intakeItems.id, intakeProposalItems.item_id), eq(intakeItems.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(intakeProposalItems.tenant_id, tenant_id),
        eq(intakeProposalItems.proposal_revision_id, row.id),
      ),
    )
    .orderBy(asc(intakeItems.id));
  return {
    revision: row.revision,
    digest: row.digest,
    title: row.title,
    body: row.body,
    target: row.target,
    items: joined.map(({ link }) => ({
      id: link.item_id,
      version: link.item_version,
      title: link.source_title,
      source_url: link.source_url,
    })),
    created_at: row.created_at.toISOString(),
  };
}

async function proposalView(
  tx: Executor,
  tenant_id: string,
  id: string,
): Promise<IntakeProposalView | null> {
  const rows = await tx
    .select()
    .from(intakeProposals)
    .where(and(eq(intakeProposals.tenant_id, tenant_id), eq(intakeProposals.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const revision = await proposalRevision(tx, tenant_id, id, row.current_revision);
  if (!revision) throw new Error("intake proposal current revision missing");
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    current_revision: row.current_revision,
    confirmed_revision: row.confirmed_revision,
    confirmed_knowledge_source_id: row.confirmed_knowledge_source_id,
    rejected_at: row.rejected_at?.toISOString() ?? null,
    stale_reason: row.stale_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    revision,
  };
}

async function validateTarget(
  tx: Executor,
  tenant_id: string,
  target: IntakeProposalTarget,
): Promise<void> {
  if ("knowledge_source_id" in target) {
    const source = await getKnowledgeSource(tenant_id, target.knowledge_source_id, tx);
    if (!source) throw new IntakeNotFoundError("proposal", target.knowledge_source_id);
    if (source.source_type !== "bundle")
      throw new IntakeConflictError("an intake proposal target must be a knowledge bundle");
    if (source.version !== target.expected_version)
      throw new IntakeConflictError("knowledge target has changed");
  } else if (!target.name.trim())
    throw new IntakeConflictError("a new knowledge bundle needs a name");
}

async function insertProposalRevision(
  tx: Executor,
  p: CreateIntakeProposalParams,
  proposal_id: string,
  revision: number,
): Promise<IntakeProposalRevisionView> {
  const items = await itemsForProposal(tx, p.tenant_id, p.item_ids, p.expected_item_versions);
  await validateTarget(tx, p.tenant_id, p.target);
  const digest = proposalDigest({ title: p.title, body: p.body, target: p.target, items });
  const [row] = await tx
    .insert(intakeProposalRevisions)
    .values({
      tenant_id: p.tenant_id,
      proposal_id,
      revision,
      title: p.title,
      body: p.body,
      target: p.target,
      digest,
      created_by_type: p.actor.kind,
      created_by_id: p.actor.id,
    })
    .returning();
  if (!row) throw new Error("intake proposal revision insertion failed");
  await tx.insert(intakeProposalItems).values(
    items.map((item) => ({
      tenant_id: p.tenant_id,
      proposal_revision_id: row.id,
      item_id: item.id,
      item_version: item.version,
      source_title: item.title,
      source_url: item.source_url,
    })),
  );
  await tx
    .update(intakeItems)
    .set({ state: "reviewing", updated_at: new Date() })
    .where(
      and(
        eq(intakeItems.tenant_id, p.tenant_id),
        inArray(
          intakeItems.id,
          items.map((item) => item.id),
        ),
      ),
    );
  return {
    revision,
    digest,
    title: p.title,
    body: p.body,
    target: p.target,
    items,
    created_at: row.created_at.toISOString(),
  };
}

export async function createIntakeProposal(
  p: CreateIntakeProposalParams,
  exec?: Executor,
): Promise<IntakeProposalView> {
  const db = exec ?? getDb();
  return (db as Db).transaction(async (tx) => {
    const [proposal] = await tx
      .insert(intakeProposals)
      .values({ tenant_id: p.tenant_id })
      .returning();
    if (!proposal) throw new Error("intake proposal insertion failed");
    await insertProposalRevision(tx, p, proposal.id, 1);
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_PROPOSAL_CREATED,
      "intake_proposal",
      proposal.id,
    );
    const view = await proposalView(tx, p.tenant_id, proposal.id);
    if (!view) throw new Error("intake proposal vanished");
    return view;
  });
}

export async function getIntakeProposal(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<IntakeProposalView | null> {
  return proposalView(exec ?? getDb(), tenant_id, id);
}

export async function listIntakeProposals(
  p: { tenant_id: string; status?: IntakeProposalView["status"] | undefined },
  exec?: Executor,
): Promise<IntakeProposalView[]> {
  const db = exec ?? getDb();
  const tenantConds = [eq(intakeProposals.tenant_id, p.tenant_id)];
  if (p.status) tenantConds.push(eq(intakeProposals.status, p.status));
  const rows = await db
    .select({ id: intakeProposals.id })
    .from(intakeProposals)
    .where(and(...tenantConds))
    .orderBy(desc(intakeProposals.updated_at));
  const views = await Promise.all(rows.map((row) => proposalView(db, p.tenant_id, row.id)));
  return views.filter((view): view is IntakeProposalView => view !== null);
}

export async function reviseIntakeProposal(
  p: ReviseIntakeProposalParams,
  exec?: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec ?? getDb();
  return (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(intakeProposals)
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)))
      .limit(1)
      .for("update");
    const proposal = rows[0];
    if (!proposal) return null;
    if (proposal.status !== "draft" && proposal.status !== "stale")
      throw new IntakeProposalConflictError("only a draft or stale proposal can be revised");
    if (proposal.current_revision !== p.expected_revision)
      throw new IntakeProposalConflictError("intake proposal has changed");
    const revision = proposal.current_revision + 1;
    await insertProposalRevision(tx, p, proposal.id, revision);
    await tx
      .update(intakeProposals)
      .set({
        status: "draft",
        stale_reason: null,
        current_revision: revision,
        updated_at: new Date(),
      })
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)));
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_PROPOSAL_REVISED,
      "intake_proposal",
      p.id,
      { revision },
    );
    return await proposalView(tx, p.tenant_id, p.id);
  });
}

function proposalMarkdown(revision: IntakeProposalRevisionView): string {
  return `# ${revision.title.trim()}\n\n${revision.body.trim()}\n`;
}

async function publishRevision(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
  proposal_id: string,
  revision: IntakeProposalRevisionView,
): Promise<string> {
  const content = proposalMarkdown(revision);
  let sourceId: string;
  if ("knowledge_source_id" in revision.target) {
    const source = await getKnowledgeSource(tenant_id, revision.target.knowledge_source_id, tx);
    if (!source || source.version !== revision.target.expected_version)
      throw new IntakeProposalConflictError("knowledge target has changed");
    const current = await getKnowledgeSourceContent(tenant_id, source.id, tx);
    if (!current || source.source_type !== "bundle")
      throw new IntakeProposalConflictError("knowledge target is not an editable bundle");
    const path = `/intake/${proposal_id}.md`;
    if (current.documents.some((document) => document.path === path))
      throw new IntakeProposalConflictError("knowledge target already contains this proposal");
    const files = [...current.documents, { path, content }];
    const params: IngestKnowledgeSourceParams = {
      tenant_id,
      knowledge_source_id: source.id,
      expected_version: revision.target.expected_version,
      actor,
      note: `confirmed intake proposal ${proposal_id}`,
      upload: {
        buffer: Buffer.from(JSON.stringify(files), "utf8"),
        filename: `${source.slug}.bundle.json`,
        mime: "application/json",
      },
      parsed_chunks: parseBundle(files).chunks,
    };
    await applyKnowledgeIngest(tx, params, await prepareKnowledgeIngest(params, tx));
    sourceId = source.id;
  } else {
    const path = `/intake/${proposal_id}.md`;
    const files = [{ path, content }];
    const params: CreateKnowledgeSourceParams = {
      tenant_id,
      actor,
      input: {
        name: revision.target.name,
        scope: "global",
        ...(revision.target.category ? { category: revision.target.category } : {}),
        ...(revision.target.tags ? { tags: revision.target.tags } : {}),
      },
      upload: {
        buffer: Buffer.from(JSON.stringify(files), "utf8"),
        filename: "intake.bundle.json",
        mime: "application/json",
      },
      source_type_override: "bundle",
      source_uri_override: `intake:${proposal_id}`,
      parsed_chunks: parseBundle(files).chunks,
      note: `confirmed intake proposal ${proposal_id}`,
    };
    const created = await applyKnowledgeCreate(
      tx,
      params,
      await prepareKnowledgeCreate(params, tx),
    );
    sourceId = created.id;
  }
  return sourceId;
}

export async function confirmIntakeProposal(
  p: ConfirmIntakeProposalParams,
  exec?: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec ?? getDb();
  let published: string | null = null;
  const view = await (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(intakeProposals)
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)))
      .limit(1)
      .for("update");
    const proposal = rows[0];
    if (!proposal) return null;
    if (proposal.status === "confirmed") {
      const current = await proposalView(tx, p.tenant_id, p.id);
      if (
        !current ||
        current.confirmed_revision !== p.expected_revision ||
        current.revision.digest !== p.digest
      )
        throw new IntakeProposalConflictError(
          "proposal was already confirmed with another revision",
        );
      return current;
    }
    if (proposal.status === "stale")
      throw new IntakeProposalConflictError("proposal must be reviewed again before confirmation");
    if (proposal.status !== "draft" || proposal.current_revision !== p.expected_revision)
      throw new IntakeProposalConflictError("proposal cannot be confirmed");
    const revision = await proposalRevision(tx, p.tenant_id, p.id, p.expected_revision);
    if (!revision || revision.digest !== p.digest)
      throw new IntakeProposalConflictError(
        "proposal confirmation does not match the reviewed content",
      );
    const currentItems = await itemsForProposal(
      tx,
      p.tenant_id,
      revision.items.map((item) => item.id),
    );
    if (
      currentItems.some(
        (item) =>
          revision.items.find((expected) => expected.id === item.id)?.version !== item.version,
      )
    )
      throw new IntakeProposalConflictError("an intake item changed after review");
    published = await publishRevision(tx, p.tenant_id, p.actor, p.id, revision);
    await tx
      .update(intakeProposals)
      .set({
        status: "confirmed",
        confirmed_revision: p.expected_revision,
        confirmed_knowledge_source_id: published,
        updated_at: new Date(),
      })
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)));
    await tx
      .update(intakeItems)
      .set({ state: "admitted", admitted_knowledge_source_id: published, updated_at: new Date() })
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          inArray(
            intakeItems.id,
            revision.items.map((item) => item.id),
          ),
        ),
      );
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_PROPOSAL_CONFIRMED,
      "intake_proposal",
      p.id,
      { revision: p.expected_revision, knowledge_source_id: published },
    );
    return await proposalView(tx, p.tenant_id, p.id);
  });
  if (published) finishKnowledgeWrite(p.tenant_id, published, db);
  return view;
}

export async function rejectIntakeProposal(
  p: { tenant_id: string; actor: Actor; id: string; expected_revision: number },
  exec?: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec ?? getDb();
  return (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(intakeProposals)
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)))
      .limit(1)
      .for("update");
    const proposal = rows[0];
    if (!proposal) return null;
    if (proposal.status !== "draft" || proposal.current_revision !== p.expected_revision)
      throw new IntakeProposalConflictError("proposal cannot be rejected");
    await tx
      .update(intakeProposals)
      .set({ status: "rejected", rejected_at: new Date(), updated_at: new Date() })
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)));
    await audit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_PROPOSAL_REJECTED,
      "intake_proposal",
      p.id,
    );
    return await proposalView(tx, p.tenant_id, p.id);
  });
}
