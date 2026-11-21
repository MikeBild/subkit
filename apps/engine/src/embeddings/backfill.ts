import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { connectorDocumentChunks } from "../db/schema/connector_docs.ts";
import { conversationMessages, conversations } from "../db/schema/conversations.ts";
import { tenants } from "../db/schema/identity.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { withTenantWork } from "../execution/tenant-work.ts";
import {
  assertTenantActive,
  lockActiveTenant,
  SelfServiceIdentityError,
} from "../identity/index.ts";
import { log } from "../logging/index.ts";
import { EMBEDDING_MODEL, embedChunkTextsPaced } from "./local-provider.ts";

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
            ? (p as { text: string }).text
            : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; content?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}

const BATCH = 16;

interface BackfillResult {
  scanned: number;
  embedded: number;
}

interface BackfillOptions {
  tenant_id?: string;
  knowledge_source_id?: string;
  connector_id?: string;
  maxBatches?: number;
}

interface BatchBudget {
  remaining: number;
}

interface ScopedBackfillOptions extends BackfillOptions {
  tenant_id: string;
}

interface BackfillDependencies {
  embed?: typeof embedChunkTextsPaced;
}

function embedInput(title: string | null, content: string): string {
  return [title, content].filter((s): s is string => !!s).join(". ");
}

async function backfillKnowledge(
  db: Executor,
  opts: ScopedBackfillOptions,
  budget: BatchBudget,
  embed: typeof embedChunkTextsPaced,
): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  while (budget.remaining > 0) {
    const rows = await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      return await tx
        .select({
          id: knowledgeChunks.id,
          title: knowledgeChunks.title,
          content: knowledgeChunks.content,
        })
        .from(knowledgeChunks)
        .where(
          and(
            isNull(knowledgeChunks.embedding),
            eq(knowledgeChunks.tenant_id, opts.tenant_id),
            opts.knowledge_source_id
              ? eq(knowledgeChunks.knowledge_source_id, opts.knowledge_source_id)
              : undefined,
          ),
        )
        .limit(BATCH);
    });
    if (rows.length === 0) break;
    budget.remaining--;
    scanned += rows.length;
    const vecs = await embed(rows.map((r) => embedInput(r.title, r.content)));
    if (vecs.every((v) => v === null)) break;
    await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      for (let i = 0; i < rows.length; i++) {
        const vec = vecs[i];
        const row = rows[i];
        if (!vec || !row) continue;
        const updated = await tx
          .update(knowledgeChunks)
          .set({ embedding: vec, embedding_model: EMBEDDING_MODEL })
          .where(
            and(
              eq(knowledgeChunks.tenant_id, opts.tenant_id),
              eq(knowledgeChunks.id, row.id),
              isNull(knowledgeChunks.embedding),
            ),
          )
          .returning({ id: knowledgeChunks.id });
        embedded += updated.length;
      }
    });
  }
  return { scanned, embedded };
}

async function backfillDocs(
  db: Executor,
  opts: ScopedBackfillOptions,
  budget: BatchBudget,
  embed: typeof embedChunkTextsPaced,
): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  while (budget.remaining > 0) {
    const rows = await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      return await tx
        .select({
          id: connectorDocumentChunks.id,
          title: connectorDocumentChunks.title,
          content: connectorDocumentChunks.content,
        })
        .from(connectorDocumentChunks)
        .where(
          and(
            isNull(connectorDocumentChunks.embedding),
            eq(connectorDocumentChunks.tenant_id, opts.tenant_id),
            opts.connector_id
              ? eq(connectorDocumentChunks.connector_id, opts.connector_id)
              : undefined,
          ),
        )
        .limit(BATCH);
    });
    if (rows.length === 0) break;
    budget.remaining--;
    scanned += rows.length;
    const vecs = await embed(rows.map((r) => embedInput(r.title, r.content)));
    if (vecs.every((v) => v === null)) break;
    await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      for (let i = 0; i < rows.length; i++) {
        const vec = vecs[i];
        const row = rows[i];
        if (!vec || !row) continue;
        const updated = await tx
          .update(connectorDocumentChunks)
          .set({ embedding: vec, embedding_model: EMBEDDING_MODEL })
          .where(
            and(
              eq(connectorDocumentChunks.tenant_id, opts.tenant_id),
              eq(connectorDocumentChunks.id, row.id),
              isNull(connectorDocumentChunks.embedding),
            ),
          )
          .returning({ id: connectorDocumentChunks.id });
        embedded += updated.length;
      }
    });
  }
  return { scanned, embedded };
}

async function backfillConversationTopics(
  db: Executor,
  opts: ScopedBackfillOptions,
  budget: BatchBudget,
  embed: typeof embedChunkTextsPaced,
): Promise<BackfillResult> {
  let scanned = 0;
  let embedded = 0;
  while (budget.remaining > 0) {
    const { convs, texts } = await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      const convs = await tx
        .select({
          id: conversations.id,
          tenant_id: conversations.tenant_id,
          title: conversations.title,
        })
        .from(conversations)
        .where(
          and(
            isNull(conversations.topic_embedding),
            eq(conversations.tenant_id, opts.tenant_id),
            sql`EXISTS (SELECT 1 FROM ${conversationMessages} WHERE ${conversationMessages.tenant_id} = ${conversations.tenant_id} AND ${conversationMessages.conversation_id} = ${conversations.id} AND ${conversationMessages.role} = 'user')`,
          ),
        )
        .limit(BATCH);
      const texts: string[] = [];
      for (const c of convs) {
        const [first] = await tx
          .select({ content: conversationMessages.content })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.tenant_id, c.tenant_id),
              eq(conversationMessages.conversation_id, c.id),
              eq(conversationMessages.role, "user"),
            ),
          )
          .orderBy(asc(conversationMessages.created_at))
          .limit(1);
        texts.push(embedInput(c.title, extractMessageText(first?.content)));
      }
      return { convs, texts };
    });
    if (convs.length === 0) break;
    budget.remaining--;
    scanned += convs.length;
    const vecs = await embed(texts);
    if (vecs.every((v) => v === null)) break;
    await db.transaction(async (tx) => {
      await lockActiveTenant(opts.tenant_id, tx);
      for (let i = 0; i < convs.length; i++) {
        const vec = vecs[i];
        const row = convs[i];
        if (!vec || !row) continue;
        const updated = await tx
          .update(conversations)
          .set({ topic_embedding: vec, topic_embedding_model: EMBEDDING_MODEL })
          .where(
            and(
              eq(conversations.tenant_id, opts.tenant_id),
              eq(conversations.id, row.id),
              isNull(conversations.topic_embedding),
            ),
          )
          .returning({ id: conversations.id });
        embedded += updated.length;
      }
    });
  }
  return { scanned, embedded };
}

export async function backfillEmbeddings(
  opts: BackfillOptions = {},
  exec?: Executor,
  dependencies: BackfillDependencies = {},
): Promise<{ knowledge: BackfillResult; docs: BackfillResult; conversations: BackfillResult }> {
  const db = exec ?? getDb();
  if ((opts.knowledge_source_id || opts.connector_id) && !opts.tenant_id)
    throw new Error("embedding_backfill_tenant_required");
  const embed = dependencies.embed ?? embedChunkTextsPaced;
  const cap = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const budgets = {
    knowledge: { remaining: cap },
    docs: { remaining: opts.knowledge_source_id ? 0 : cap },
    conversations: { remaining: opts.knowledge_source_id ? 0 : cap },
  };
  const knowledge: BackfillResult = { scanned: 0, embedded: 0 };
  const docs: BackfillResult = { scanned: 0, embedded: 0 };
  const convTopics: BackfillResult = { scanned: 0, embedded: 0 };
  const dispatch = (tenantId: string) =>
    withTenantWork(tenantId, async () => {
      await assertTenantActive(tenantId, db);
      const scoped = { ...opts, tenant_id: tenantId };
      for (const [run, budget, result] of [
        [backfillKnowledge, budgets.knowledge, knowledge],
        [backfillDocs, budgets.docs, docs],
        [backfillConversationTopics, budgets.conversations, convTopics],
      ] as const) {
        const batch = await run(db, scoped, budget, embed);
        result.scanned += batch.scanned;
        result.embedded += batch.embedded;
      }
    });
  if (opts.tenant_id) {
    await dispatch(opts.tenant_id);
  } else {
    let cursor: string | undefined;
    while (Object.values(budgets).some((budget) => budget.remaining > 0)) {
      const page = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(
          and(
            eq(tenants.status, "active"),
            isNull(tenants.deleted_at),
            cursor ? gt(tenants.id, cursor) : undefined,
            or(
              budgets.knowledge.remaining > 0
                ? sql`EXISTS (SELECT 1 FROM ${knowledgeChunks} WHERE ${knowledgeChunks.tenant_id} = ${tenants.id} AND ${knowledgeChunks.embedding} IS NULL)`
                : undefined,
              budgets.docs.remaining > 0
                ? sql`EXISTS (SELECT 1 FROM ${connectorDocumentChunks} WHERE ${connectorDocumentChunks.tenant_id} = ${tenants.id} AND ${connectorDocumentChunks.embedding} IS NULL)`
                : undefined,
              budgets.conversations.remaining > 0
                ? sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${conversations.tenant_id} = ${tenants.id} AND ${conversations.topic_embedding} IS NULL AND EXISTS (SELECT 1 FROM ${conversationMessages} WHERE ${conversationMessages.tenant_id} = ${tenants.id} AND ${conversationMessages.conversation_id} = ${conversations.id} AND ${conversationMessages.role} = 'user'))`
                : undefined,
            ),
          ),
        )
        .orderBy(asc(tenants.id))
        .limit(64);
      if (page.length === 0) break;
      for (const tenant of page) {
        if (!Object.values(budgets).some((budget) => budget.remaining > 0)) break;
        try {
          await dispatch(tenant.id);
        } catch (error) {
          if (!(error instanceof SelfServiceIdentityError) || error.code !== "tenant_unavailable")
            throw error;
        }
      }
      cursor = page.at(-1)?.id;
      if (page.length < 64) break;
    }
  }
  log.info({
    module: "embeddings",
    action: "backfill.completed",
    msg: "embedding backfill finished",
    knowledge_embedded: knowledge.embedded,
    knowledge_scanned: knowledge.scanned,
    docs_embedded: docs.embedded,
    docs_scanned: docs.scanned,
    conversations_embedded: convTopics.embedded,
    conversations_scanned: convTopics.scanned,
  });
  return { knowledge, docs, conversations: convTopics };
}
