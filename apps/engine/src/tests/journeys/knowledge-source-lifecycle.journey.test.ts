import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let sourceId: string;

beforeAll(async () => {
  ctx = await createJourneyCtx("knowledge-lifecycle");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("knowledge source lifecycle", () => {
  test("AC1: create knowledge source via multipart upload", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob(
        ["# API Guidelines\n\nAll endpoints must return JSON.\nPagination uses cursor tokens."],
        {
          type: "text/markdown",
        },
      ),
      "api-guidelines.md",
    );
    form.append("metadata", JSON.stringify({ name: "API Guidelines", scope: "global" }));

    const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; chunk_count: number };
    expect(body.name).toBe("API Guidelines");
    expect(body.chunk_count).toBeGreaterThan(0);
    sourceId = body.id;
  });

  test("AC2: list includes the created source", async () => {
    const res = await journeyFetch(ctx, "/v1/knowledge-sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.find((s) => s.id === sourceId)).toBeDefined();
  });

  test("AC3: search finds content from the source", async () => {
    const res = await journeyFetch(ctx, "/v1/knowledge-sources/search?q=pagination+cursor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ snippet: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
  });

  test("AC4: get by id returns source details", async () => {
    const res = await journeyFetch(ctx, `/v1/knowledge-sources/${sourceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe(sourceId);
  });

  test("AC5: update metadata", async () => {
    const res = await journeyFetch(ctx, `/v1/knowledge-sources/${sourceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated Guidelines", description: "Updated description" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; description: string };
    expect(body.name).toBe("Updated Guidelines");
    expect(body.description).toBe("Updated description");
  });

  test("AC6: delete removes from search", async () => {
    const delRes = await journeyFetch(ctx, `/v1/knowledge-sources/${sourceId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    const searchRes = await journeyFetch(ctx, "/v1/knowledge-sources/search?q=pagination");
    expect(searchRes.status).toBe(200);
    const hits = (await searchRes.json()) as { hits: unknown[] };
    expect(hits.hits.length).toBe(0);
  });

  test("AC7: audit trail records all operations", async () => {
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.resource_id, sourceId));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("knowledge_source.created");
    expect(actions).toContain("knowledge_source.updated");
    expect(actions).toContain("knowledge_source.deleted");
  });
});
