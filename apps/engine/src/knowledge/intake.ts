import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  type IntakeCollectedSnapshot,
  intakeCategoryDefaults,
  intakeItems,
  intakeProposalItems,
  intakeProposalRevisions,
  intakeProposals,
} from "../db/schema/intake.ts";
import { redactSecretShapes } from "../logging/scrub-secrets.ts";
import { absorbedRequestKey, intakeGroupKey } from "./core/intake-dedupe.ts";
import {
  appendToOpenDuplicate,
  collectedEvidenceExcerpt,
  type IntakeDedupeDeps,
  replayAbsorbedRequest,
  similarOpenIntakeItem,
} from "./intake-dedupe.ts";
import { proposalDigest, requestDigest } from "./intake-digest.ts";
import { IntakeConflictError, IntakeProposalConflictError } from "./intake-errors.ts";
import {
  DEFAULT_INTAKE_CATEGORY,
  defaultIntakeCategory,
  INTAKE_ORIGIN_FILTER_VALUES,
  intakeItemView,
  parseIntakeCategory,
  recordIntakeAudit,
} from "./intake-rows.ts";
import {
  intakeConfirmRequirements,
  type PublishedIntakeTarget,
  publishIntakeRevision,
  validateIntakeTarget,
} from "./intake-targets.ts";
import type {
  ConfirmIntakeProposalParams,
  CreateIntakeItemParams,
  CreateIntakeProposalParams,
  DeleteIntakeItemParams,
  IntakeCategoryView,
  IntakeItemOriginFilter,
  IntakeItemView,
  IntakeProposalItemView,
  IntakeProposalRevisionView,
  IntakeProposalView,
  PatchIntakeItemParams,
  ReviseIntakeProposalParams,
  SetIntakeDefaultCategoryParams,
} from "./intake-types.ts";
import { assertConfirmerMayAdmit } from "./persistence/intake-confirm.ts";
import { lockIntakeRequest } from "./persistence/intake-dedupe.ts";
import { finishKnowledgeWrite } from "./service.ts";

function redactCollected(p: CreateIntakeItemParams): {
  params: CreateIntakeItemParams;
  redactions: number;
} {
  let redactions = 0;
  const clean = (value: string): string => {
    const r = redactSecretShapes(value);
    redactions += r.count;
    return r.text;
  };
  const cleanOptional = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : clean(value);
  const source = p.original_snapshot;
  const params: CreateIntakeItemParams = {
    ...p,
    title: clean(p.title),
    body: clean(p.body),
    source_author: cleanOptional(p.source_author),
    note: cleanOptional(p.note),
    original_snapshot: source && {
      ...source,
      title: cleanOptional(source.title),
      body: cleanOptional(source.body),
      source_author: cleanOptional(source.source_author),
    },
  };
  return { params, redactions };
}

function snapshot(p: CreateIntakeItemParams, redactions = 0): IntakeCollectedSnapshot {
  const source = p.original_snapshot;
  const sourceUrl = source?.source_url ?? p.source_url;
  const described = {
    ...((source?.source_author ?? p.source_author)
      ? { source_author: source?.source_author ?? p.source_author }
      : {}),
    ...((source?.published_at ?? p.published_at)
      ? { published_at: source?.published_at ?? p.published_at }
      : {}),
    captured_at: source?.captured_at ?? p.captured_at,
    body: source?.body ?? p.body,
  };
  const title = source?.title ?? p.title;
  const redacted = redactions > 0 ? { redactions } : {};
  return sourceUrl === undefined
    ? {
        title,
        ...described,
        origin: "note",
        ...redacted,
        ...(p.attachment ? { attachment: p.attachment } : {}),
      }
    : {
        title,
        source_url: sourceUrl,
        ...described,
        origin: source?.origin ?? "capture",
        ...redacted,
      };
}

function itemRequestDigest(p: CreateIntakeItemParams, intakeCategory: string): string {
  return requestDigest({
    actor: p.actor,
    category: intakeCategory,
    title: p.title,
    source_url: p.source_url ?? null,
    source_author: p.source_author ?? null,
    published_at: p.published_at ?? null,
    captured_at: p.captured_at,
    body: p.body,
    note: p.note ?? "",
    original_snapshot: snapshot(p),
  });
}

export async function listIntakeCategories(
  p: { tenant_id: string; actor: Actor },
  exec: Executor,
): Promise<{ items: IntakeCategoryView[]; default_category: string }> {
  const db = exec;
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
  const default_category = defaults[0]?.category ?? DEFAULT_INTAKE_CATEGORY;
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
  exec: Executor,
): Promise<{ category: string }> {
  const db = exec;
  const intakeCategory = parseIntakeCategory(p.category);
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
    await recordIntakeAudit(
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
  exec: Executor,
  deps: IntakeDedupeDeps = {},
): Promise<IntakeItemView> {
  const db = exec;
  const similar_id =
    p.actor.kind === "anonymous"
      ? null
      : await similarOpenIntakeItem(
          exec,
          { ...p, target: null, exclude_request_id: p.client_request_id },
          deps.embedder,
        );
  return (db as Db).transaction(async (tx) => {
    const intakeCategory = p.category
      ? parseIntakeCategory(p.category)
      : p.actor.kind === "anonymous"
        ? DEFAULT_INTAKE_CATEGORY
        : await defaultIntakeCategory(tx, p.tenant_id, p.actor);
    const digest = itemRequestDigest(p, intakeCategory);
    const { params: clean, redactions } = redactCollected(p);
    await lockIntakeRequest(tx, p.tenant_id, p.client_request_id);
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
      return intakeItemView(previous[0]);
    }
    const absorbed = await replayAbsorbedRequest(tx, {
      tenant_id: p.tenant_id,
      client_request_id: p.client_request_id,
      digest,
    });
    if (absorbed) return absorbed;
    const collected = snapshot(clean, redactions);
    const duplicate =
      p.actor.kind === "anonymous"
        ? null
        : await appendToOpenDuplicate(tx, {
            tenant_id: p.tenant_id,
            actor: p.actor,
            target: null,
            source_url: collected.source_url,
            similar_id,
            agent: collected.origin,
            session_id: absorbedRequestKey(p.client_request_id, digest),
            repo: null,
            excerpt: collectedEvidenceExcerpt(collected.source_url, clean.body),
            captured_at: p.captured_at,
          });
    if (duplicate) return duplicate;
    const inserted = await tx
      .insert(intakeItems)
      .values({
        tenant_id: p.tenant_id,
        category: intakeCategory,
        client_request_id: p.client_request_id,
        creation_request_digest: digest,
        original_snapshot: collected,
        title: clean.title,
        body: clean.body,
        note: clean.note ?? "",
        attachment_file_id: p.attachment?.file_id ?? null,
        group_key: intakeGroupKey({ source_url: collected.source_url }),
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
      return intakeItemView(row);
    }
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_ITEM_COLLECTED,
      "intake_item",
      row.id,
      {
        category: intakeCategory,
        origin: row.original_snapshot.origin,
        source_url: row.original_snapshot.source_url ?? null,
        redactions: row.original_snapshot.redactions ?? 0,
        ...(p.attachment ? { attachment_file_id: p.attachment.file_id } : {}),
      },
    );
    return intakeItemView(row);
  });
}

export async function listIntakeItems(
  p: {
    tenant_id: string;
    category?: string | undefined;
    state?: IntakeItemView["state"] | undefined;
    origin?: IntakeItemOriginFilter | undefined;
  },
  exec: Executor,
): Promise<IntakeItemView[]> {
  const db = exec;
  const tenantConds = [eq(intakeItems.tenant_id, p.tenant_id)];
  if (p.category) tenantConds.push(eq(intakeItems.category, parseIntakeCategory(p.category)));
  if (p.state) tenantConds.push(eq(intakeItems.state, p.state));
  if (p.origin)
    tenantConds.push(
      inArray(sql<string>`${intakeItems.original_snapshot}->>'origin'`, [
        ...INTAKE_ORIGIN_FILTER_VALUES[p.origin],
      ]),
    );
  return (
    await db
      .select()
      .from(intakeItems)
      .where(and(...tenantConds))
      .orderBy(desc(intakeItems.updated_at))
  ).map(intakeItemView);
}

export async function getIntakeItem(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<IntakeItemView | null> {
  const db = exec;
  const rows = await db
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenant_id), eq(intakeItems.id, id)))
    .limit(1);
  return rows[0] ? intakeItemView(rows[0]) : null;
}

interface IntakeItemReviewSubject {
  id: string;
  title: string;
  state: IntakeItemView["state"];
  version: number;
}

export async function getIntakeItemsForReview(
  tenant_id: string,
  ids: readonly string[],
  exec: Executor,
): Promise<IntakeItemReviewSubject[]> {
  if (ids.length === 0) return [];
  const db = exec;
  return db
    .select({
      id: intakeItems.id,
      title: intakeItems.title,
      state: intakeItems.state,
      version: intakeItems.version,
    })
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenant_id), inArray(intakeItems.id, [...ids])));
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
  const locked = await tx
    .select({ id: intakeProposals.id })
    .from(intakeProposals)
    .where(
      and(
        eq(intakeProposals.tenant_id, tenant_id),
        eq(intakeProposals.status, "draft"),
        inArray(intakeProposals.id, ids),
      ),
    )
    .orderBy(asc(intakeProposals.id))
    .for("update");
  if (!locked.length) return;
  await tx
    .update(intakeProposals)
    .set({ status: "stale", stale_reason: reason, updated_at: new Date() })
    .where(
      and(
        eq(intakeProposals.tenant_id, tenant_id),
        eq(intakeProposals.status, "draft"),
        inArray(
          intakeProposals.id,
          locked.map((row) => row.id),
        ),
      ),
    );
}

export async function patchIntakeItem(
  p: PatchIntakeItemParams,
  exec: Executor,
): Promise<IntakeItemView | null> {
  const db = exec;
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
    let redactions = 0;
    const clean = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const r = redactSecretShapes(value);
      redactions += r.count;
      return r.text;
    };
    const title = clean(p.title);
    const body = clean(p.body);
    const note = clean(p.note);
    const contentChanged =
      p.title !== undefined ||
      p.body !== undefined ||
      p.note !== undefined ||
      p.category !== undefined ||
      p.state !== undefined;
    const [row] = await tx
      .update(intakeItems)
      .set({
        ...(p.category !== undefined ? { category: parseIntakeCategory(p.category) } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(note !== undefined ? { note } : {}),
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
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_ITEM_UPDATED,
      "intake_item",
      p.id,
      {
        version: row.version,
        ...(p.category !== undefined ? { category: row.category } : {}),
        ...(redactions > 0 ? { redactions } : {}),
      },
    );
    return intakeItemView(row);
  });
}

export async function deleteDiscardedIntakeItem(
  p: DeleteIntakeItemParams,
  exec: Executor,
): Promise<boolean> {
  const db = exec;
  return (db as Db).transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, p.tenant_id), eq(intakeItems.id, p.id)))
      .limit(1)
      .for("update");
    const existing = rows[0];
    if (!existing) return false;
    if (existing.version !== p.expected_version)
      throw new IntakeConflictError("intake item has changed");
    if (existing.state !== "discarded")
      throw new IntakeConflictError("only discarded intake items can be permanently deleted");

    await staleDraftProposalsForItems(tx, p.tenant_id, [p.id], "intake_item_deleted");
    const detached = await tx
      .delete(intakeProposalItems)
      .where(
        and(eq(intakeProposalItems.tenant_id, p.tenant_id), eq(intakeProposalItems.item_id, p.id)),
      )
      .returning({ proposal_revision_id: intakeProposalItems.proposal_revision_id });
    await tx
      .delete(intakeItems)
      .where(and(eq(intakeItems.tenant_id, p.tenant_id), eq(intakeItems.id, p.id)));
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_ITEM_DELETED,
      "intake_item",
      p.id,
      {
        category: existing.category,
        origin: existing.original_snapshot.origin,
        detached_proposal_items: detached.length,
      },
    );
    return true;
  });
}

async function itemsForProposal(
  tx: Executor,
  tenant_id: string,
  item_ids: string[],
  expected_item_versions?: Record<string, number> | undefined,
  allowDecided = false,
): Promise<IntakeProposalItemView[]> {
  const unique = [...new Set(item_ids)];
  if (!unique.length) throw new IntakeConflictError("a proposal needs at least one intake item");
  const rows = await tx
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, tenant_id), inArray(intakeItems.id, unique)))
    .orderBy(asc(intakeItems.id))
    .for("update");
  if (rows.length !== unique.length)
    throw new IntakeConflictError("a proposal item was not found in this tenant");
  if (!allowDecided && rows.some((row) => row.state === "discarded" || row.state === "admitted"))
    throw new IntakeConflictError("discarded or admitted items cannot be proposed");
  if (
    expected_item_versions &&
    rows.some((row) => expected_item_versions[row.id] !== row.version)
  ) {
    throw new IntakeConflictError("an intake item changed after it was read");
  }
  const byId = new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        version: row.version,
        title: row.title,
        source_url: row.original_snapshot.source_url ?? null,
      },
    ]),
  );
  return unique.map((id) => {
    const item = byId.get(id);
    if (!item) throw new IntakeConflictError("a proposal item was not found in this tenant");
    return item;
  });
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
    items: joined.map(({ item, link }) => ({
      id: link.item_id,
      version: link.item_version,
      title: link.source_title,
      source_url: link.source_url,
      source_author: item.original_snapshot.source_author ?? null,
      published_at: item.original_snapshot.published_at ?? null,
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
    confirmed_target_kind: row.confirmed_target_kind,
    confirmed_target_id: row.confirmed_target_id,
    rejected_at: row.rejected_at?.toISOString() ?? null,
    stale_reason: row.stale_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    revision,
  };
}

async function insertProposalRevision(
  tx: Executor,
  p: CreateIntakeProposalParams,
  proposal_id: string,
  revision: number,
  items: IntakeProposalItemView[],
): Promise<IntakeProposalRevisionView> {
  await validateIntakeTarget(tx, p.tenant_id, p.target);
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
  exec: Executor,
): Promise<IntakeProposalView> {
  const db = exec;
  return (db as Db).transaction(async (tx) => {
    const items = await itemsForProposal(tx, p.tenant_id, p.item_ids, p.expected_item_versions);
    const [proposal] = await tx
      .insert(intakeProposals)
      .values({ tenant_id: p.tenant_id })
      .returning();
    if (!proposal) throw new Error("intake proposal insertion failed");
    await insertProposalRevision(tx, p, proposal.id, 1, items);
    await recordIntakeAudit(
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
  exec: Executor,
): Promise<IntakeProposalView | null> {
  return proposalView(exec, tenant_id, id);
}

export async function listIntakeProposals(
  p: { tenant_id: string; status?: IntakeProposalView["status"] | undefined },
  exec: Executor,
): Promise<IntakeProposalView[]> {
  const db = exec;
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
  exec: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec;
  return (db as Db).transaction(async (tx) => {
    const items = await itemsForProposal(tx, p.tenant_id, p.item_ids, p.expected_item_versions);
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
    await insertProposalRevision(tx, p, proposal.id, revision, items);
    await tx
      .update(intakeProposals)
      .set({
        status: "draft",
        stale_reason: null,
        current_revision: revision,
        updated_at: new Date(),
      })
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)));
    await recordIntakeAudit(
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

export async function confirmIntakeProposal(
  p: ConfirmIntakeProposalParams,
  exec: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec;
  let published: PublishedIntakeTarget | null = null;
  const view = await (db as Db).transaction(async (tx) => {
    const preflight = await proposalRevision(tx, p.tenant_id, p.id, p.expected_revision);
    const lockedItems = preflight
      ? await itemsForProposal(
          tx,
          p.tenant_id,
          preflight.items.map((item) => item.id),
          undefined,
          true,
        )
      : null;
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
      await p.authorize(
        intakeConfirmRequirements(current.revision.target),
        current.revision.target,
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
    await p.authorize(intakeConfirmRequirements(revision.target), revision.target);
    await assertConfirmerMayAdmit(tx, {
      tenant_id: p.tenant_id,
      proposal_id: p.id,
      revision: p.expected_revision,
      confirmer: p.actor,
    });
    if (!lockedItems) throw new IntakeProposalConflictError("proposal cannot be confirmed");
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
    const target = await publishIntakeRevision(tx, p.tenant_id, p.actor, p.id, revision);
    published = target;
    await tx
      .update(intakeProposals)
      .set({
        status: "confirmed",
        confirmed_revision: p.expected_revision,
        confirmed_target_kind: target.kind,
        confirmed_target_id: target.id,
        updated_at: new Date(),
      })
      .where(and(eq(intakeProposals.tenant_id, p.tenant_id), eq(intakeProposals.id, p.id)));
    await tx
      .update(intakeItems)
      .set({
        state: "admitted",
        admitted_target_kind: target.kind,
        admitted_target_id: target.id,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          inArray(
            intakeItems.id,
            revision.items.map((item) => item.id),
          ),
        ),
      );
    await staleDraftProposalsForItems(
      tx,
      p.tenant_id,
      revision.items.map((item) => item.id),
      "intake_item_admitted",
    );
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_PROPOSAL_CONFIRMED,
      "intake_proposal",
      p.id,
      {
        revision: p.expected_revision,
        target_kind: target.kind,
        target_id: target.id,
        ...(target.kind === "knowledge" ? { knowledge_source_id: target.id } : {}),
        ...(target.kind === "skill" ? { superseded_skill_ids: target.superseded_skill_ids } : {}),
      },
    );
    return await proposalView(tx, p.tenant_id, p.id);
  });
  const done = published as PublishedIntakeTarget | null;
  if (done?.kind === "knowledge") finishKnowledgeWrite(p.tenant_id, done.id, db);
  return view;
}

export async function rejectIntakeProposal(
  p: { tenant_id: string; actor: Actor; id: string; expected_revision: number },
  exec: Executor,
): Promise<IntakeProposalView | null> {
  const db = exec;
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
    await recordIntakeAudit(
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
