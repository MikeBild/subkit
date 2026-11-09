import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { waitForTenantWorkDrain } from "../../execution/index.ts";
import {
  createKnowledgeSource,
  getKnowledgeSearchCacheStats,
  invalidateKnowledgeCache,
  searchKnowledge,
  setKnowledgeSearchCachePublishHookForTests,
} from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";
let ctx: KnowledgeTestCtx;

async function addSource(
  tenantId: string,
  name: string,
  content: string,
  tags: string[] = [],
): Promise<string> {
  const source = await createKnowledgeSource(
    {
      tenant_id: tenantId,
      input: { name, scope: "global", tags },
      upload: { buffer: Buffer.from(content), filename: `${name}.txt`, mime: "text/plain" },
      actor: null,
    },
    ctx.testDb.db,
  );
  return source.id;
}

beforeAll(async () => {
  if (!skip) ctx = await createKnowledgeTestCtx("search-cache-race");
}, 60_000);

afterAll(async () => {
  setKnowledgeSearchCachePublishHookForTests(undefined);
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge search cache publication", () => {
  test("does not cache a stale in-flight search after invalidation", async () => {
    const query = "cache race mutation token";
    const oldId = await addSource(ctx.tenantId, "cache-race-old", `${query} old result`);
    await waitForTenantWorkDrain();
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "cache-race-other", display_name: "Cache Race Other" })
      .returning();
    expect(otherTenant).toBeDefined();
    const otherId = await addSource(otherTenant!.id, "cache-race-other", `${query} other tenant`);
    await waitForTenantWorkDrain();

    invalidateKnowledgeCache(otherTenant!.id);
    const otherFirst = await searchKnowledge({ tenant_id: otherTenant!.id, query }, ctx.testDb.db);
    expect(otherFirst.map((hit) => hit.knowledge_source_id)).toContain(otherId);

    invalidateKnowledgeCache(ctx.tenantId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    setKnowledgeSearchCachePublishHookForTests(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      const staleSearch = searchKnowledge({ tenant_id: ctx.tenantId, query }, ctx.testDb.db);
      await entered.promise;
      invalidateKnowledgeCache(ctx.tenantId);
      const freshId = await addSource(ctx.tenantId, "cache-race-fresh", `${query} fresh result`);
      await waitForTenantWorkDrain();
      release.resolve();
      const stale = await staleSearch;
      expect(stale.map((hit) => hit.knowledge_source_id)).toEqual([oldId]);

      setKnowledgeSearchCachePublishHookForTests(undefined);
      const fresh = await searchKnowledge({ tenant_id: ctx.tenantId, query }, ctx.testDb.db);
      expect(fresh.map((hit) => hit.knowledge_source_id)).toContain(freshId);

      const beforeNormalHit = getKnowledgeSearchCacheStats().hits;
      const normalAgain = await searchKnowledge({ tenant_id: ctx.tenantId, query }, ctx.testDb.db);
      expect(normalAgain.map((hit) => hit.id)).toEqual(fresh.map((hit) => hit.id));
      expect(getKnowledgeSearchCacheStats().hits).toBe(beforeNormalHit + 1);

      const beforeOtherHit = getKnowledgeSearchCacheStats().hits;
      const otherAgain = await searchKnowledge(
        { tenant_id: otherTenant!.id, query },
        ctx.testDb.db,
      );
      expect(otherAgain.map((hit) => hit.knowledge_source_id)).toContain(otherId);
      expect(getKnowledgeSearchCacheStats().hits).toBe(beforeOtherHit + 1);
    } finally {
      release.resolve();
      setKnowledgeSearchCachePublishHookForTests(undefined);
    }
  });
});

test.skipIf(skip)(
  "tag delimiters cannot return another filter's cached search results",
  async () => {
    const query = "uniquecachetagseparator";
    const comma = await addSource(ctx.tenantId, "comma-tag", query, ["a,b"]);
    const separate = await addSource(ctx.tenantId, "separate-tags", query, ["a", "b"]);
    await waitForTenantWorkDrain();
    invalidateKnowledgeCache(ctx.tenantId);
    const commaHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query, tags: ["a,b"] },
      ctx.testDb.db,
    );
    const separateHits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query, tags: ["a", "b"] },
      ctx.testDb.db,
    );
    expect(commaHits.map((hit) => hit.knowledge_source_id)).toEqual([comma]);
    expect(separateHits.map((hit) => hit.knowledge_source_id)).toEqual([separate]);
  },
);
