// knowledge.ingest failure surfacing (DB-backed).
//
// Pins the contract added with the `last_error` column: a terminal
// ingest failure flips the source row to status='error' with the
// failure message in last_error (and writes an audit row); the next
// successful ingest clears both fields again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";

import { auditLog } from "../../db/schema/audit.ts";
import { knowledgeSources } from "../../db/schema/index.ts";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "../../knowledge/tests/setup.ts";
import { type IngestKnowledgeJob, processIngestKnowledgeJob } from "./ingest-knowledge.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip.
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
    // Oversized content trips the knowledge budget guard inside
    // ingestKnowledgeSource — a deterministic terminal failure.
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
