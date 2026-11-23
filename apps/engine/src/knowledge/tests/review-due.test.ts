import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { listDueKnowledgeReviews } from "../review-due.ts";
import { createKnowledgeSource, updateKnowledgeSource } from "../service.ts";
import { UpdateKnowledgeSourceSchema } from "../types.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";
let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  if (!skip) ctx = await createKnowledgeTestCtx("review-due");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function addSource(name: string) {
  return createKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      input: { name, scope: "global" },
      upload: {
        buffer: Buffer.from(`# ${name}\n\nBody.`),
        filename: `${name}.md`,
        mime: "text/markdown",
      },
      actor: null,
    },
    ctx.testDb.db,
  );
}

function setReview(id: string, review_due_at: string | null) {
  return updateKnowledgeSource(
    {
      tenant_id: ctx.tenantId,
      id,
      patch: UpdateKnowledgeSourceSchema.parse({ review_due_at }),
      actor_id: null,
      actor: null,
    },
    ctx.testDb.db,
  );
}

describe("review date of a knowledge source", () => {
  test("the API body accepts an ISO date with offset or null and rejects other text", () => {
    expect(
      UpdateKnowledgeSourceSchema.safeParse({ review_due_at: "2026-12-01T00:00:00Z" }).success,
    ).toBe(true);
    expect(UpdateKnowledgeSourceSchema.safeParse({ review_due_at: null }).success).toBe(true);
    expect(UpdateKnowledgeSourceSchema.safeParse({ review_due_at: "next week" }).success).toBe(
      false,
    );
  });

  test.skipIf(skip)("is stored, read back, reported as due and cleared", async () => {
    const source = await addSource("care-runbook");
    expect(source.review_due_at).toBeNull();
    const later = await addSource("care-later");

    const set = await setReview(source.id, "2026-11-01T09:00:00.000Z");
    expect(set?.review_due_at).toBe("2026-11-01T09:00:00.000Z");
    await setReview(later.id, "2027-01-01T00:00:00.000Z");

    const due = await listDueKnowledgeReviews(
      ctx.testDb.db,
      ctx.tenantId,
      new Date("2026-11-23T00:00:00.000Z"),
    );
    expect(due).toEqual({
      count: 1,
      oldest_due_at: "2026-11-01T09:00:00.000Z",
      sources: [{ id: source.id, name: "care-runbook", review_due_at: "2026-11-01T09:00:00.000Z" }],
    });

    const cleared = await setReview(source.id, null);
    expect(cleared?.review_due_at).toBeNull();
    expect(
      (
        await listDueKnowledgeReviews(
          ctx.testDb.db,
          ctx.tenantId,
          new Date("2026-11-23T00:00:00.000Z"),
        )
      ).count,
    ).toBe(0);
  });
});
