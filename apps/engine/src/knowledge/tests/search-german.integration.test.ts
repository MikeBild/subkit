import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { knowledgeChunks } from "../../db/schema/index.ts";
import type { QueryEmbedder } from "../../embeddings/index.ts";
import { updateWorkspaceSettings } from "../../identity/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { KNOWLEDGE_CHUNK_TARGET_BYTES } from "../core/chunking.ts";
import { knowledgeScopeFilter } from "../search-fts.ts";
import { fuseKnowledgeWithVectors } from "../search-vectors.ts";
import { createKnowledgeSource, invalidateKnowledgeCache, searchKnowledge } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;
let germanTenantId: string;

const DELIVERY_NOTE = "# Lieferungen\n\nAlle Lieferungen kommen montags im Lager an.";

async function addNote(tenant_id: string, name: string, text: string) {
  return createKnowledgeSource(
    {
      tenant_id,
      input: { name, scope: "global" },
      upload: { buffer: Buffer.from(text), filename: `${name}.md`, mime: "text/markdown" },
      actor: null,
    },
    ctx.testDb.db,
  );
}

async function ftsConfigs(tenant_id: string): Promise<string[]> {
  const rows = await ctx.testDb.db
    .select({ fts_config: knowledgeChunks.fts_config })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.tenant_id, tenant_id));
  return [...new Set(rows.map((r) => r.fts_config))];
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("search-german");
  const german = await seedTenant(ctx.testDb.db, { slug: "t-search-german-de", language: "de" });
  germanTenantId = german.id;
  await addNote(germanTenantId, "lieferungen", DELIVERY_NOTE);
  await addNote(ctx.tenantId, "lieferungen", DELIVERY_NOTE);
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge search in the workspace language", () => {
  test("a German workspace stores its chunks with the German dictionary", async () => {
    expect(await ftsConfigs(germanTenantId)).toEqual(["german"]);
    expect(await ftsConfigs(ctx.tenantId)).toEqual(["english"]);
  });

  test("the singular finds the plural through German stemming", async () => {
    const hits = await searchKnowledge(
      { tenant_id: germanTenantId, query: "Lieferung" },
      ctx.testDb.db,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("<b>Lieferungen</b>");
  });

  test("the same text in an English workspace does not match the other word form", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "Lieferung" },
      ctx.testDb.db,
    );
    expect(hits).toEqual([]);
  });

  test("changing the workspace language re-indexes its chunks", async () => {
    await updateWorkspaceSettings(
      {
        tenant_id: ctx.tenantId,
        language: "de",
        actor_type: "user",
        actor_id: "00000000-0000-4000-8000-000000000001",
      },
      ctx.testDb.db,
    );
    invalidateKnowledgeCache(ctx.tenantId);
    expect(await ftsConfigs(ctx.tenantId)).toEqual(["german"]);
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "Lieferung" },
      ctx.testDb.db,
    );
    expect(hits).toHaveLength(1);
  });

  test("a long document is stored in chunks within the small target", async () => {
    const paragraph = (n: number) =>
      Array.from({ length: 120 }, (_, i) => `word${n}x${i}`).join(" ");
    const body = Array.from({ length: 40 }, (_, n) => paragraph(n)).join("\n\n");
    const source = await addNote(germanTenantId, "long", `# Long\n\n${body}`);
    const rows = await ctx.testDb.db
      .select({ byte_size: knowledgeChunks.byte_size })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, source.id));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.byte_size).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_TARGET_BYTES);
  });
});

describe.skipIf(skip)("knowledge vector scan", () => {
  const embedder: QueryEmbedder = { available: async () => true, embed: async () => [1, 0, 0] };

  test("the paged scan finds the nearest chunk beyond the first page and fuses by rank", async () => {
    const tenant = await seedTenant(ctx.testDb.db, { slug: "t-search-german-vec" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const source = await addNote(tenant.id, `note-${i}`, `# Note ${i}\n\nplain text ${i}`);
      ids.push(source.id);
      await ctx.testDb.db
        .update(knowledgeChunks)
        .set({ embedding: i === 4 ? [1, 0, 0] : i === 3 ? [0.6, 0.8, 0] : [0, 1, 0] })
        .where(eq(knowledgeChunks.knowledge_source_id, source.id));
    }
    const p = { tenant_id: tenant.id, query: "anything at all" };
    const hits = await fuseKnowledgeWithVectors(ctx.testDb.db, p, [], knowledgeScopeFilter(p), 10, {
      embedder,
      batch: 2,
    });
    expect(hits.map((h) => h.knowledge_source_id).sort()).toEqual(ids.slice(3).sort());
    expect(hits.map((h) => h.rank)).toEqual([1, 0.6]);
    expect(hits[0]?.snippet).toContain("plain text");
  });

  test("the scan stops at its ceiling", async () => {
    const tenant = await seedTenant(ctx.testDb.db, { slug: "t-search-german-ceil" });
    for (let i = 0; i < 3; i += 1) {
      const source = await addNote(tenant.id, `capped-${i}`, `# Capped ${i}\n\nbody ${i}`);
      await ctx.testDb.db
        .update(knowledgeChunks)
        .set({ embedding: [1, 0, 0] })
        .where(eq(knowledgeChunks.knowledge_source_id, source.id));
    }
    const p = { tenant_id: tenant.id, query: "anything at all" };
    const hits = await fuseKnowledgeWithVectors(ctx.testDb.db, p, [], knowledgeScopeFilter(p), 10, {
      embedder,
      batch: 1,
      ceiling: 2,
    });
    expect(hits).toHaveLength(2);
  });
});
