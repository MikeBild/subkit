import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectorDocumentChunks, connectorDocuments } from "../../db/schema/connector_docs.ts";
import { conversationMessages, conversations } from "../../db/schema/conversations.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createKnowledgeSource, kickSourceEmbeddingBackfill } from "../../knowledge/service.ts";
import { backfillEmbeddings } from "../backfill.ts";

const skip = process.env.REQUIRES_PG === "0";
const skipEmbeddingE2E = skip || process.env.RUN_EMBEDDING_E2E !== "1";

interface SeededTargets {
  tenantId: string;
  knowledgeSourceId: string;
}

async function seedAllThreeTargets(testDb: TestDb, label: string): Promise<SeededTargets> {
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Backfill Scoping ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  const tenantId = tenant.id;

  const [source] = await testDb.db
    .insert(knowledgeSources)
    .values({
      tenant_id: tenantId,
      name: `Source ${label}`,
      slug: `source-${label}`,
      source_type: "file_upload",
      source_uri: `${label}.md`,
      version: "v1",
    })
    .returning();
  if (!source) throw new Error("seed knowledge source failed");
  await testDb.db.insert(knowledgeChunks).values({
    tenant_id: tenantId,
    knowledge_source_id: source.id,
    ordinal: 0,
    title: "Chunk",
    content: "Knowledge chunk content awaiting embedding.",
    byte_size: 40,
    fingerprint: `fp-${label}-knowledge`,
  });

  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: `cn-${label}`,
      display_name: `Connector ${label}`,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning();
  if (!connector) throw new Error("seed connector failed");
  const [doc] = await testDb.db
    .insert(connectorDocuments)
    .values({
      tenant_id: tenantId,
      connector_id: connector.id,
      source_type: "openapi",
      source_uri: "https://example.test/openapi.json",
      version: "v1",
    })
    .returning();
  if (!doc) throw new Error("seed connector document failed");
  await testDb.db.insert(connectorDocumentChunks).values({
    tenant_id: tenantId,
    connector_id: connector.id,
    document_id: doc.id,
    ordinal: 0,
    title: "Doc chunk",
    content: "Connector doc chunk content awaiting embedding.",
    byte_size: 45,
    fingerprint: `fp-${label}-doc`,
  });

  const [conv] = await testDb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conversation failed");
  await testDb.db.insert(conversationMessages).values({
    tenant_id: tenantId,
    conversation_id: conv.id,
    role: "user",
    content: "Help me set up a new workflow for invoice reconciliation.",
  });

  return { tenantId, knowledgeSourceId: source.id };
}

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("backfill-scoping");
});

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
});

describe.skipIf(skip)("embeddings/backfillEmbeddings scoping", () => {
  test("knowledge_source_id-scoped call skips the docs and conversation-topic passes", async () => {
    const { tenantId, knowledgeSourceId } = await seedAllThreeTargets(testDb, "source-scoped");

    const result = await backfillEmbeddings(
      { tenant_id: tenantId, knowledge_source_id: knowledgeSourceId },
      testDb.db,
    );

    expect(result.knowledge.scanned).toBeGreaterThanOrEqual(1);
    expect(result.docs.scanned).toBe(0);
    expect(result.docs.embedded).toBe(0);
    expect(result.conversations.scanned).toBe(0);
    expect(result.conversations.embedded).toBe(0);
  });

  test("bare tenant_id (no knowledge_source_id) still runs all three passes", async () => {
    const { tenantId } = await seedAllThreeTargets(testDb, "bare-tenant");

    const result = await backfillEmbeddings({ tenant_id: tenantId }, testDb.db);

    expect(result.knowledge.scanned).toBeGreaterThanOrEqual(1);
    expect(result.docs.scanned).toBeGreaterThanOrEqual(1);
    expect(result.conversations.scanned).toBeGreaterThanOrEqual(1);
  });
});

let e2eTestDb: TestDb;
let e2eTenantId: string;

beforeAll(async () => {
  if (skipEmbeddingE2E) return;
  e2eTestDb = await createTestDb("backfill-scoping-e2e");
  const [tenant] = await e2eTestDb.db
    .insert(tenants)
    .values({ slug: "backfill-scoping-e2e", display_name: "Backfill Scoping E2E" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  e2eTenantId = tenant.id;
}, 120_000);

afterAll(async () => {
  if (!skipEmbeddingE2E && e2eTestDb?.cleanup) await e2eTestDb.cleanup();
}, 30_000);

describe.skipIf(skipEmbeddingE2E)(
  "knowledge/kickSourceEmbeddingBackfill (opt-in, model required)",
  () => {
    test("a source is fully embedded (findable) right after kickSourceEmbeddingBackfill", async () => {
      const source = await createKnowledgeSource(
        {
          tenant_id: e2eTenantId,
          input: { name: "Kick Backfill Source", scope: "global" },
          upload: {
            buffer: Buffer.from(
              "# Reconciliation\n\nMatch bank transactions against invoices to close the " +
                "books at month end. Flag any unmatched amount for manual review.",
            ),
            filename: "reconciliation.md",
            mime: "text/markdown",
          },
          actor_id: null,
        },
        e2eTestDb.db,
      );

      await kickSourceEmbeddingBackfill(e2eTenantId, source.id, e2eTestDb.db);

      const rows = await e2eTestDb.db
        .select({ id: knowledgeChunks.id, embedding: knowledgeChunks.embedding })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledge_source_id, source.id));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.embedding !== null)).toBe(true);
    });
  },
);
