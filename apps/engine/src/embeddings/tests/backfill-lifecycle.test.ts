import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectorDocumentChunks, connectorDocuments } from "../../db/schema/connector_docs.ts";
import { conversationMessages, conversations } from "../../db/schema/conversations.ts";
import { authIdentities, connectors, tenants } from "../../db/schema/index.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { backfillEmbeddings } from "../backfill.ts";

let ctx: TestDb;
const vector = () => Array.from({ length: 384 }, () => 0.25);
beforeAll(async () => {
  ctx = await createTestDb("backfill-lifecycle");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function seed(label: string, count = 1, hosted = false) {
  const [identity] = hosted
    ? await ctx.db
        .insert(authIdentities)
        .values({
          issuer_url: "https://identity.example.test",
          subject: label,
          email: `${label}@example.test`,
        })
        .returning()
    : [];
  if (hosted && !identity) throw new Error("missing identity");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: label,
      display_name: label,
      ...(identity ? { origin: "self_service" as const, owner_identity_id: identity.id } : {}),
    })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  const [source] = await ctx.db
    .insert(knowledgeSources)
    .values({
      tenant_id: tenant.id,
      name: label,
      slug: label,
      source_type: "file_upload",
      source_uri: "fixture.md",
      version: "fixture",
    })
    .returning();
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: label,
      display_name: label,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning();
  if (!source || !connector) throw new Error("missing parent");
  const [document] = await ctx.db
    .insert(connectorDocuments)
    .values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      source_type: "markdown",
      source_uri: "https://example.test/docs",
      version: "fixture",
    })
    .returning();
  if (!document) throw new Error("missing document");
  for (let ordinal = 0; ordinal < count; ordinal++) {
    await ctx.db.insert(knowledgeChunks).values({
      tenant_id: tenant.id,
      knowledge_source_id: source.id,
      ordinal,
      title: label,
      content: `${label} knowledge`,
      byte_size: 20,
      fingerprint: `${label}-${ordinal}`,
    });
    await ctx.db.insert(connectorDocumentChunks).values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      document_id: document.id,
      ordinal,
      title: label,
      content: `${label} docs`,
      byte_size: 20,
      fingerprint: `${label}-${ordinal}`,
    });
    const [conversation] = await ctx.db
      .insert(conversations)
      .values({ tenant_id: tenant.id, title: label, status: "active" })
      .returning();
    if (!conversation) throw new Error("missing conversation");
    await ctx.db.insert(conversationMessages).values({
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      role: "user",
      content: `${label} conversation`,
    });
  }
  return { tenantId: tenant.id, sourceId: source.id };
}

async function expectUnembedded(tenantId: string) {
  const chunks = await ctx.db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.tenant_id, tenantId));
  const docs = await ctx.db
    .select()
    .from(connectorDocumentChunks)
    .where(eq(connectorDocumentChunks.tenant_id, tenantId));
  const threads = await ctx.db
    .select()
    .from(conversations)
    .where(eq(conversations.tenant_id, tenantId));
  expect(chunks.every((row) => row.embedding === null)).toBe(true);
  expect(docs.every((row) => row.embedding === null)).toBe(true);
  expect(threads.every((row) => row.topic_embedding === null)).toBe(true);
}

test("global backfill excludes inactive tenants before reading their content", async () => {
  const blocked = [];
  for (const status of ["suspended", "pending_deletion", "deleted"] as const) {
    const fixture = await seed(`excluded-${status}`, 1, true);
    await ctx.db
      .update(tenants)
      .set({
        status: status === "deleted" ? "active" : status,
        ...(status === "deleted" ? { deleted_at: new Date(FROZEN_NOW) } : {}),
        ...(status === "pending_deletion"
          ? {
              deletion_requested_at: new Date(FROZEN_NOW),
              deletion_scheduled_for: new Date(FROZEN_NOW + 7 * 86400000),
            }
          : {}),
      })
      .where(eq(tenants.id, fixture.tenantId));
    blocked.push(fixture.tenantId);
  }
  const active = await seed("eligible");
  const observed: string[] = [];
  const result = await backfillEmbeddings({ maxBatches: 1 }, ctx.db, {
    embed: async (texts) => {
      expect(tenantWorkSnapshot(active.tenantId).in_flight).toBeGreaterThan(0);
      observed.push(...texts);
      return texts.map(vector);
    },
  });
  expect(observed).toHaveLength(3);
  expect(observed.every((text) => text.includes("eligible") && !text.includes("excluded"))).toBe(
    true,
  );
  expect(result.knowledge.embedded).toBe(1);
  expect(result.docs.embedded).toBe(1);
  expect(result.conversations.embedded).toBe(1);
  for (const tenantId of blocked) {
    await expectUnembedded(tenantId);
    await expect(
      backfillEmbeddings({ tenant_id: tenantId }, ctx.db, {
        embed: async () => {
          throw new Error("unexpected provider");
        },
      }),
    ).rejects.toThrow("tenant_unavailable");
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  }
});

test("the registry covers the actual embedding promise and suspension prevents its late writes", async () => {
  const fixture = await seed("suspension-race");
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = backfillEmbeddings(
    { tenant_id: fixture.tenantId, knowledge_source_id: fixture.sourceId },
    ctx.db,
    {
      embed: async (texts) => {
        entered();
        await held;
        return texts.map(vector);
      },
    },
  );
  const outcome = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await Promise.race([
    ready,
    outcome.then((error) => {
      if (error) throw error;
    }),
  ]);
  try {
    expect(tenantWorkSnapshot(fixture.tenantId).in_flight).toBe(1);
    await ctx.db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, fixture.tenantId));
  } finally {
    release();
  }
  expect(await outcome).toMatchObject({ code: "tenant_unavailable" });
  expect(tenantWorkSnapshot(fixture.tenantId).in_flight).toBe(0);
  await expectUnembedded(fixture.tenantId);
});

test("global batch caps are shared across tenants separately for all three passes", async () => {
  const first = await seed("global-cap-first", 17);
  const second = await seed("global-cap-second", 17);
  let calls = 0;
  const result = await backfillEmbeddings({ maxBatches: 1 }, ctx.db, {
    embed: async (texts) => {
      calls++;
      expect(
        tenantWorkSnapshot(first.tenantId).in_flight +
          tenantWorkSnapshot(second.tenantId).in_flight,
      ).toBe(1);
      return texts.map(vector);
    },
  });
  expect(calls).toBe(3);
  for (const count of Object.values(result)) expect(count).toEqual({ scanned: 16, embedded: 16 });
});

test("source scoped backfill leaves neighboring docs conversations and sources unchanged", async () => {
  const fixture = await seed("source-boundary");
  const [neighbor] = await ctx.db
    .insert(knowledgeSources)
    .values({
      tenant_id: fixture.tenantId,
      name: "neighbor",
      slug: "neighbor",
      source_type: "file_upload",
      source_uri: "neighbor.md",
      version: "fixture",
    })
    .returning();
  if (!neighbor) throw new Error("missing neighbor");
  await ctx.db.insert(knowledgeChunks).values({
    tenant_id: fixture.tenantId,
    knowledge_source_id: neighbor.id,
    ordinal: 0,
    title: "neighbor",
    content: "neighbor unchanged",
    byte_size: 18,
    fingerprint: "neighbor",
  });
  const result = await backfillEmbeddings(
    { tenant_id: fixture.tenantId, knowledge_source_id: fixture.sourceId },
    ctx.db,
    { embed: async (texts) => texts.map(vector) },
  );
  expect(result.knowledge).toEqual({ scanned: 1, embedded: 1 });
  expect(result.docs).toEqual({ scanned: 0, embedded: 0 });
  expect(result.conversations).toEqual({ scanned: 0, embedded: 0 });
  const docs = await ctx.db
    .select()
    .from(connectorDocumentChunks)
    .where(eq(connectorDocumentChunks.tenant_id, fixture.tenantId));
  const threads = await ctx.db
    .select()
    .from(conversations)
    .where(eq(conversations.tenant_id, fixture.tenantId));
  const neighborChunks = await ctx.db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.tenant_id, fixture.tenantId));
  expect(
    neighborChunks.find((row) => row.knowledge_source_id === neighbor.id)?.embedding,
  ).toBeNull();
  expect(docs[0]?.embedding).toBeNull();
  expect(threads[0]?.topic_embedding).toBeNull();
  await expect(
    backfillEmbeddings({ knowledge_source_id: fixture.sourceId }, ctx.db),
  ).rejects.toThrow("embedding_backfill_tenant_required");
});
