import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createKnowledgeSource, searchKnowledge } from "../service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;
let guidelinesId: string;
let dunningId: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("search-tolerant");

  const guidelines = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: "API Guidelines", scope: "global" },
      upload: {
        buffer: Buffer.from(
          "# API Guidelines\n\nPagination uses cursor-based tokens.\nRate limiting applies at 100 requests per minute.",
        ),
        filename: "api-guidelines.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    ctx.testDb.db,
  );
  guidelinesId = guidelines.id;

  const dunning = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: "Dunning Rules", scope: "global", tags: ["domain:invoicing"] },
      upload: {
        buffer: Buffer.from(
          "# Dunning Rules\n\nEscalate to the second letter after thirty days.\nNever contact customers on public holidays.",
        ),
        filename: "dunning.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    ctx.testDb.db,
  );
  dunningId = dunning.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("knowledge/search — tolerant full-text", () => {
  test("a query whose words only partly match still finds the chunk", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "export weekly pagination report for zebras" },
      ctx.testDb.db,
    );
    expect(hits.some((h) => h.knowledge_source_id === guidelinesId)).toBe(true);
  });

  test("a domain tag that matches a query word includes its source", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "Send overdue invoice reminders every Monday" },
      ctx.testDb.db,
    );
    expect(hits.some((h) => h.knowledge_source_id === dunningId)).toBe(true);
  });

  test("an all-terms match keeps the strict result set", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "pagination cursor" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.knowledge_source_id === guidelinesId)).toBe(true);
  });

  test("unrelated words still return nothing", async () => {
    const hits = await searchKnowledge(
      { tenant_id: ctx.tenantId, query: "xyznonexistentterm qqqunknownword" },
      ctx.testDb.db,
    );
    expect(hits.length).toBe(0);
  });

  test("the tolerant fallback stays inside the tenant", async () => {
    const [other] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "t-search-tolerant-other", display_name: "Other" })
      .returning();
    const hits = await searchKnowledge(
      { tenant_id: other!.id, query: "overdue invoice pagination reminders" },
      ctx.testDb.db,
    );
    expect(hits.length).toBe(0);
  });
});
