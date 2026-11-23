import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { CategorySchema } from "../api/catalog-metadata.ts";
import type { Actor } from "../audit/actor.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { catalogCategories } from "../db/schema/catalog_categories.ts";
import {
  type IntakeSessionSnapshot,
  intakeItemEvidence,
  intakeItems,
} from "../db/schema/intake.ts";
import { ensureNamedSystemAccount } from "../identity/service.ts";
import { intakeGroupKey } from "./core/intake-dedupe.ts";
import {
  appendToOpenDuplicate,
  type IntakeDedupeDeps,
  similarOpenIntakeItem,
} from "./intake-dedupe.ts";
import { requestDigest } from "./intake-digest.ts";
import {
  defaultIntakeCategory,
  intakeActor,
  intakeItemView,
  recordIntakeAudit,
} from "./intake-rows.ts";
import type {
  CreateSessionIntakeItemParams,
  IntakeItemEvidenceRead,
  IntakeItemEvidenceView,
  SessionIntakeItemResult,
} from "./intake-types.ts";

const SESSION_COLLECTOR_NAME = "session-learnings";
const SESSION_REQUEST_NAMESPACE = "5f0e7a3c-9d41-4b6e-8a2f-1c7d3e9b4a60";

export function normalizeIntakeTitle(title: string): string {
  return title.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function uuidV5(name: string, namespace: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sessionIntakeRequestId(p: {
  tenant_id: string;
  session_id: string;
  title: string;
}): string {
  return uuidV5(
    `${p.tenant_id}\n${p.session_id}\n${normalizeIntakeTitle(p.title)}`,
    SESSION_REQUEST_NAMESPACE,
  );
}

async function sessionCategory(
  tx: Executor,
  tenant_id: string,
  domains: readonly string[],
  collector: Actor,
): Promise<string> {
  for (const domain of domains) {
    const parsed = CategorySchema.safeParse(domain);
    if (!parsed.success) continue;
    const rows = await tx
      .select({ name: catalogCategories.name, redirect_to: catalogCategories.redirect_to })
      .from(catalogCategories)
      .where(
        and(eq(catalogCategories.tenant_id, tenant_id), eq(catalogCategories.name, parsed.data)),
      )
      .limit(1);
    const row = rows[0];
    if (row) return row.redirect_to ?? row.name;
  }
  return defaultIntakeCategory(tx, tenant_id, collector);
}

async function appendEvidence(
  tx: Executor,
  p: CreateSessionIntakeItemParams,
  item_id: string,
  collector: Actor,
): Promise<boolean> {
  const inserted = await tx
    .insert(intakeItemEvidence)
    .values({
      tenant_id: p.tenant_id,
      item_id,
      agent: p.session.agent,
      session_id: p.session.session_id,
      repo: p.session.repo ?? null,
      excerpt: p.session.evidence_excerpt,
      captured_at: new Date(p.captured_at),
      recorded_by_type: collector.kind,
      recorded_by_id: collector.id,
    })
    .onConflictDoNothing()
    .returning({ id: intakeItemEvidence.id });
  return inserted.length > 0;
}

async function sessionCollector(
  tx: Executor,
  tenant_id: string,
  actor: Actor | null,
): Promise<Actor> {
  if (actor) return actor;
  const account = await ensureNamedSystemAccount(
    {
      tenant_id,
      name: SESSION_COLLECTOR_NAME,
      description: "Collects coding-agent session learnings into intake",
    },
    tx,
  );
  return { kind: "system_account", id: account.id };
}

function learningSnapshot(
  learning: CreateSessionIntakeItemParams["learning"],
): Partial<IntakeSessionSnapshot> {
  if (!learning) return {};
  return {
    ...(learning.kind ? { learning_kind: learning.kind } : {}),
    ...(learning.scope ? { scope: learning.scope } : {}),
    ...(learning.connector_id ? { connector_id: learning.connector_id } : {}),
    ...(learning.workflow_id ? { workflow_id: learning.workflow_id } : {}),
    ...(learning.tags?.length ? { tags: [...learning.tags] } : {}),
  };
}

export async function createSessionIntakeItem(
  p: CreateSessionIntakeItemParams,
  exec?: Executor,
  deps: IntakeDedupeDeps = {},
): Promise<SessionIntakeItemResult> {
  const db = exec ?? getDb();
  const client_request_id = sessionIntakeRequestId({
    tenant_id: p.tenant_id,
    session_id: p.session.session_id,
    title: p.title,
  });
  const similar_id = await similarOpenIntakeItem(
    db,
    { ...p, exclude_request_id: client_request_id },
    deps.embedder,
  );
  return (db as Db).transaction(async (tx) => {
    const collector = await sessionCollector(tx, p.tenant_id, p.actor);
    const replayed = await tx
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          eq(intakeItems.client_request_id, client_request_id),
        ),
      )
      .limit(1);
    if (replayed[0]) {
      await appendEvidence(tx, p, replayed[0].id, collector);
      return { item: intakeItemView(replayed[0]), outcome: "replayed" as const };
    }
    const intakeCategory = await sessionCategory(tx, p.tenant_id, p.session.domains, collector);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${p.tenant_id}:intake-title:${intakeCategory}:${normalizeIntakeTitle(p.title)}`}))`,
    );
    const duplicates = await tx
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          eq(intakeItems.category, intakeCategory),
          sql`${intakeItems.original_snapshot} ->> 'origin' = 'session'`,
          sql`lower(regexp_replace(btrim(${intakeItems.title}), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(${p.title}), '[[:space:]]+', ' ', 'g'))`,
        ),
      )
      .orderBy(asc(intakeItems.created_at))
      .limit(1);
    const duplicate = duplicates[0];
    if (duplicate) {
      if (await appendEvidence(tx, p, duplicate.id, collector))
        await recordIntakeAudit(
          tx,
          p.tenant_id,
          collector,
          AuditAction.INTAKE_ITEM_EVIDENCE_APPENDED,
          "intake_item",
          duplicate.id,
          {
            agent: p.session.agent,
            session_id: p.session.session_id,
            ...(p.request_source ? { request_source: p.request_source } : {}),
          },
        );
      return { item: intakeItemView(duplicate), outcome: "evidence_appended" as const };
    }
    const related = await appendToOpenDuplicate(tx, {
      tenant_id: p.tenant_id,
      actor: collector,
      source_url: p.source_url,
      similar_id,
      agent: p.session.agent,
      session_id: p.session.session_id,
      repo: p.session.repo ?? null,
      excerpt: p.session.evidence_excerpt,
      captured_at: p.captured_at,
      request_source: p.request_source,
    });
    if (related) return { item: related, outcome: "evidence_appended" as const };
    const original_snapshot: IntakeSessionSnapshot = {
      title: p.title,
      ...(p.source_url ? { source_url: p.source_url } : {}),
      captured_at: p.captured_at,
      body: p.body,
      origin: "session",
      agent: p.session.agent,
      ...(p.session.client ? { client: p.session.client } : {}),
      session_id: p.session.session_id,
      repo: p.session.repo ?? null,
      domains: [...p.session.domains],
      evidence_excerpt: p.session.evidence_excerpt,
      ...learningSnapshot(p.learning),
    };
    const [row] = await tx
      .insert(intakeItems)
      .values({
        tenant_id: p.tenant_id,
        category: intakeCategory,
        client_request_id,
        creation_request_digest: requestDigest({
          actor: collector,
          category: intakeCategory,
          original_snapshot,
        }),
        original_snapshot,
        title: p.title,
        body: p.body,
        collected_by_type: collector.kind,
        collected_by_id: collector.id,
        group_key: intakeGroupKey({
          source_url: p.source_url,
          repo: p.session.repo,
          tags: p.learning?.tags,
        }),
      })
      .returning();
    if (!row) throw new Error("session intake item insertion failed");
    await appendEvidence(tx, p, row.id, collector);
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      collector,
      AuditAction.INTAKE_ITEM_COLLECTED,
      "intake_item",
      row.id,
      {
        category: intakeCategory,
        origin: "session",
        agent: p.session.agent,
        ...(p.request_source ? { request_source: p.request_source } : {}),
      },
    );
    return { item: intakeItemView(row), outcome: "created" as const };
  });
}

function evidenceView(row: typeof intakeItemEvidence.$inferSelect): IntakeItemEvidenceView {
  return {
    id: row.id,
    item_id: row.item_id,
    agent: row.agent,
    session_id: row.session_id,
    repo: row.repo,
    excerpt: row.excerpt,
    captured_at: row.captured_at.toISOString(),
    recorded_by: intakeActor(row.recorded_by_type, row.recorded_by_id),
    created_at: row.created_at.toISOString(),
  };
}

export async function listIntakeItemEvidence(
  tenant_id: string,
  item_id: string,
  exec?: Executor,
): Promise<IntakeItemEvidenceView[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(intakeItemEvidence)
    .where(
      and(eq(intakeItemEvidence.tenant_id, tenant_id), eq(intakeItemEvidence.item_id, item_id)),
    )
    .orderBy(asc(intakeItemEvidence.created_at), asc(intakeItemEvidence.id));
  return rows.map(evidenceView);
}

export async function readIntakeItemEvidence(
  p: { tenant_id: string; item_id: string; limit: number },
  exec?: Executor,
): Promise<IntakeItemEvidenceRead> {
  const db = exec ?? getDb();
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(intakeItemEvidence)
      .where(
        and(
          eq(intakeItemEvidence.tenant_id, p.tenant_id),
          eq(intakeItemEvidence.item_id, p.item_id),
        ),
      )
      .orderBy(desc(intakeItemEvidence.captured_at), desc(intakeItemEvidence.id))
      .limit(p.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(intakeItemEvidence)
      .where(
        and(
          eq(intakeItemEvidence.tenant_id, p.tenant_id),
          eq(intakeItemEvidence.item_id, p.item_id),
        ),
      ),
  ]);
  return { evidence: rows.map(evidenceView), evidence_total: Number(counted[0]?.total ?? 0) };
}
