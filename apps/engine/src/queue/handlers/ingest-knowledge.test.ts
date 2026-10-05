import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import { auditLog } from "../../db/schema/audit.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/index.ts";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "../../knowledge/tests/setup.ts";
import {
  createKnowledgeSourceFromUrl,
  refreshKnowledgeSource,
} from "../../knowledge/url-source.ts";
import { type IngestKnowledgeJob, processIngestKnowledgeJob } from "./ingest-knowledge.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: KnowledgeTestCtx;
let sourceId: string;

function jobFor(data: IngestKnowledgeJob): Job<IngestKnowledgeJob> {
  return { id: "job-test", name: "knowledge.ingest", data } as Job<IngestKnowledgeJob>;
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("ingest-failure");
  const created = await createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name: "Refresh Target", scope: "global" },
      upload: { buffer: Buffer.from("# seed\ninitial content\n"), filename: "seed.md" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  sourceId = created.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("queue/handlers/ingest-knowledge — failure surfacing", () => {
  test("terminal failure flips the row to status='error' with last_error + audit", async () => {
    const oversized = "x".repeat(51 * 1024 * 1024);
    await expect(
      processIngestKnowledgeJob(
        jobFor({
          tenant_id: ctx.tenantId,
          knowledge_source_id: sourceId,
          filename: "huge.md",
          content: oversized,
        }),
        ctx.testDb.db,
      ),
    ).rejects.toThrow();

    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, ctx.tenantId), eq(knowledgeSources.id, sourceId)));
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.last_error ?? "").toContain("maximum size");

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "knowledge_source.updated"));
    expect(audits.some((a) => a.resource_id === sourceId)).toBe(true);
  });

  test("the next successful ingest clears status + last_error", async () => {
    await processIngestKnowledgeJob(
      jobFor({
        tenant_id: ctx.tenantId,
        knowledge_source_id: sourceId,
        filename: "fixed.md",
        content: "# fixed\nall good again\n",
      }),
      ctx.testDb.db,
    );
    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, ctx.tenantId), eq(knowledgeSources.id, sourceId)));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.last_error).toBeNull();
  });
});

describe.skipIf(skip)(
  "queue/handlers/ingest-knowledge — scheduled refresh reads the address",
  () => {
    let page: Server;
    let pageBody = "<html><body><p>Erste Fassung.</p></body></html>";
    let pageUrl = "";

    beforeAll(async () => {
      page = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageBody);
      });
      await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
      const address = page.address();
      if (address === null || typeof address === "string") throw new Error("no page server port");
      pageUrl = `http://127.0.0.1:${address.port}/handbuch`;
    });

    afterAll(async () => {
      page.closeAllConnections?.();
      await new Promise<void>((resolve) => page.close(() => resolve()));
    });

    async function chunkText(id: string): Promise<string> {
      const rows = await ctx.testDb.db
        .select({ content: knowledgeChunks.content })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledge_source_id, id));
      return rows.map((r) => r.content).join("\n");
    }

    test("the job fetches the page again instead of ingesting empty content", async () => {
      const source = await createKnowledgeSourceFromUrl(
        { tenant_id: ctx.tenantId, actor_id: null, url: pageUrl, input: { scope: "global" } },
        ctx.testDb.db,
      );
      expect(await chunkText(source.id)).toContain("Erste Fassung");
      pageBody = "<html><body><p>Zweite Fassung.</p></body></html>";
      await processIngestKnowledgeJob(
        jobFor({
          tenant_id: ctx.tenantId,
          knowledge_source_id: source.id,
          filename: pageUrl,
          content: "",
          read_address_again: true,
        }),
        ctx.testDb.db,
      );
      const text = await chunkText(source.id);
      expect(text).toContain("Zweite Fassung");
      expect(text).not.toContain("Erste Fassung");
    });

    test("reading the address now moves the read time, even when the page did not change", async () => {
      const source = await createKnowledgeSourceFromUrl(
        {
          tenant_id: ctx.tenantId,
          actor_id: null,
          url: `${pageUrl}-jetzt`,
          input: { scope: "global" },
        },
        ctx.testDb.db,
      );
      const before = source.last_refreshed_at;
      expect(before).not.toBeNull();
      await Bun.sleep(20);
      const refreshed = await refreshKnowledgeSource(
        { tenant_id: ctx.tenantId, actor_id: null, id: source.id },
        ctx.testDb.db,
      );
      expect(refreshed?.last_refreshed_at).not.toBeNull();
      expect(Date.parse(refreshed?.last_refreshed_at ?? "")).toBeGreaterThan(
        Date.parse(before ?? ""),
      );
    });

    test("a source without an address is refused, not emptied", async () => {
      await expect(
        processIngestKnowledgeJob(
          jobFor({
            tenant_id: ctx.tenantId,
            knowledge_source_id: sourceId,
            filename: "fixed.md",
            content: "",
            read_address_again: true,
          }),
          ctx.testDb.db,
        ),
      ).rejects.toThrow();
      expect(await chunkText(sourceId)).toContain("all good again");
    });
  },
);
