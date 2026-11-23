import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, dataMigrations, intakeItems } from "../../db/index.ts";
import { runIntakeGroupKeyBackfill } from "../backfills/intake-group-key-v1.ts";
import {
  createIntakeItem,
  createSessionIntakeItem,
  IntakeConflictError,
  intakeItemByRequestId,
  listIntakeItemEvidence,
  patchIntakeItem,
} from "../index.ts";
import type { IntakeEmbedder } from "../intake-dedupe.ts";
import {
  actor,
  type createClip,
  ctx,
  nextUuid,
  sessionInput,
  skip,
  useKnowledgeIntakeDb,
  withoutSimilarity,
} from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

const embedder: IntakeEmbedder = {
  available: async () => true,
  embed: async (texts) =>
    texts.map((text) =>
      text.includes("granite")
        ? [1, 0, 0]
        : text.includes("basalt")
          ? [0.95, Math.sqrt(1 - 0.95 ** 2), 0]
          : text.includes("pumice")
            ? [0.8, 0.6, 0]
            : [0, 0, 1],
    ),
};

function clipWith(overrides: Parameters<typeof createClip>[0], withEmbedder = false) {
  return createIntakeItem(
    {
      tenant_id: ctx.tenantId,
      actor,
      client_request_id: nextUuid(),
      title: "Rock notes",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Plain body.",
      ...overrides,
    },
    ctx.testDb.db,
    withEmbedder ? { embedder } : withoutSimilarity,
  );
}

async function evidenceAudits(item_id: string) {
  return ctx.testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "intake_item.evidence_appended"),
        eq(auditLog.resource_id, item_id),
      ),
    );
}

describe.skipIf(skip)("intake backlog dedupe", () => {
  test("a capture of the same normalized address appends evidence to the open item", async () => {
    const first = await clipWith({ source_url: "https://www.dedupe-a.test/post/" });
    expect(first.group_key).toBe("site:dedupe-a.test");
    const request = nextUuid();
    const again = await clipWith({
      client_request_id: request,
      source_url: "http://dedupe-a.test/post?utm_source=mail#top",
      body: "A second look at the same page.",
    });
    expect(again.id).toBe(first.id);
    expect(again.body).toBe(first.body);
    const evidence = await listIntakeItemEvidence(ctx.tenantId, first.id, ctx.testDb.db);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      agent: "capture",
      session_id: expect.stringMatching(new RegExp(`^${request}:[0-9a-f]{64}$`)),
    });
    expect(evidence[0]?.excerpt).toContain("A second look");
    expect(await evidenceAudits(first.id)).toEqual([
      { metadata: expect.objectContaining({ match: "source_url", agent: "capture" }) },
    ]);

    const replay = await clipWith({
      client_request_id: request,
      source_url: "http://dedupe-a.test/post?utm_source=mail#top",
      body: "A second look at the same page.",
    });
    expect(replay.id).toBe(first.id);
    expect(await listIntakeItemEvidence(ctx.tenantId, first.id, ctx.testDb.db)).toHaveLength(1);
    expect((await intakeItemByRequestId(ctx.testDb.db, ctx.tenantId, request))?.id).toBe(first.id);
  });

  test("an absorbed request id replayed with different content is a conflict", async () => {
    const first = await clipWith({ source_url: "https://dedupe-f.test/post" });
    const request = nextUuid();
    await clipWith({ client_request_id: request, source_url: "https://dedupe-f.test/post" });
    await expect(
      clipWith({
        client_request_id: request,
        source_url: "https://dedupe-f.test/post",
        body: "Other content under the same request id.",
      }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    await expect(
      clipWith({ client_request_id: request, title: "Unrelated note", body: "Elsewhere." }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    expect(await listIntakeItemEvidence(ctx.tenantId, first.id, ctx.testDb.db)).toHaveLength(1);
  });

  test("an absorbed request replays its item after that item left the open backlog", async () => {
    const first = await clipWith({ source_url: "https://dedupe-g.test/post" });
    const request = nextUuid();
    await clipWith({ client_request_id: request, source_url: "https://dedupe-g.test/post" });
    await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: first.id,
        expected_version: first.version,
        state: "discarded",
      },
      ctx.testDb.db,
    );
    const replay = await clipWith({
      client_request_id: request,
      source_url: "https://dedupe-g.test/post",
    });
    expect(replay.id).toBe(first.id);
    expect(replay.state).toBe("discarded");
    expect(await listIntakeItemEvidence(ctx.tenantId, first.id, ctx.testDb.db)).toHaveLength(1);
  });

  test("similar session learnings join only an item with the same learning target", async () => {
    const workflowA = nextUuid();
    const workflowB = nextUuid();
    const learning = (workflow_id: string) => ({
      kind: "practice" as const,
      scope: "workflow" as const,
      workflow_id,
    });
    const first = await createSessionIntakeItem(
      sessionInput({
        title: "granite judge",
        body: "granite empty",
        learning: learning(workflowA),
      }),
      ctx.testDb.db,
      { embedder },
    );
    const other = await createSessionIntakeItem(
      sessionInput({ title: "basalt judge", body: "basalt empty", learning: learning(workflowB) }),
      ctx.testDb.db,
      { embedder },
    );
    expect(other.outcome).toBe("created");
    expect(other.item.id).not.toBe(first.item.id);
    const same = await createSessionIntakeItem(
      sessionInput({ title: "basalt again", body: "basalt empty", learning: learning(workflowA) }),
      ctx.testDb.db,
      { embedder },
    );
    expect(same.outcome).toBe("evidence_appended");
    expect(same.item.id).toBe(first.item.id);
  });

  test("a session learning with a target never joins a capture of the same address", async () => {
    const capture = await clipWith({ source_url: "https://dedupe-h.test/guide" });
    const result = await createSessionIntakeItem(
      sessionInput({
        title: "Workflow guide learning",
        source_url: "https://dedupe-h.test/guide",
        learning: { scope: "workflow", workflow_id: nextUuid() },
      }),
      ctx.testDb.db,
      withoutSimilarity,
    );
    expect(result.outcome).toBe("created");
    expect(result.item.id).not.toBe(capture.id);
  });

  test("a discarded item is never a dedupe target", async () => {
    const first = await clipWith({ source_url: "https://dedupe-b.test/x" });
    await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: first.id,
        expected_version: first.version,
        state: "discarded",
      },
      ctx.testDb.db,
    );
    const again = await clipWith({ source_url: "https://dedupe-b.test/x" });
    expect(again.id).not.toBe(first.id);
    expect(again.state).toBe("collected");
  });

  test("an anonymous capture is collected on its own", async () => {
    const first = await clipWith({ source_url: "https://dedupe-c.test/x" });
    const anonymous = await clipWith({
      actor: { kind: "anonymous", id: null },
      source_url: "https://dedupe-c.test/x",
    });
    expect(anonymous.id).not.toBe(first.id);
  });

  test("similar title and body at cosine 0.9 or more append evidence; less creates an item", async () => {
    const first = await clipWith({ title: "granite facts", body: "granite is hard" }, true);
    const similar = await clipWith({ title: "basalt facts", body: "basalt is dark" }, true);
    expect(similar.id).toBe(first.id);
    expect(await evidenceAudits(first.id)).toEqual([
      { metadata: expect.objectContaining({ match: "similar", agent: "note" }) },
    ]);
    const different = await clipWith({ title: "pumice facts", body: "pumice floats" }, true);
    expect(different.id).not.toBe(first.id);
    expect(different.group_key).toBeNull();
  });

  test("a session learning about a collected address joins that item", async () => {
    const capture = await clipWith({ source_url: "https://dedupe-d.test/guide" });
    const result = await createSessionIntakeItem(
      sessionInput({ title: "Guide learning", source_url: "https://dedupe-d.test/guide/" }),
      ctx.testDb.db,
      withoutSimilarity,
    );
    expect(result.outcome).toBe("evidence_appended");
    expect(result.item.id).toBe(capture.id);
    const evidence = await listIntakeItemEvidence(ctx.tenantId, capture.id, ctx.testDb.db);
    expect(evidence.map((e) => e.agent)).toEqual(["claude-code"]);

    const created = await createSessionIntakeItem(
      sessionInput({ title: "Separate session learning", body: "Unrelated." }),
      ctx.testDb.db,
      withoutSimilarity,
    );
    expect(created.outcome).toBe("created");
    expect(created.item.group_key).toBe("repo:example/repo");
  });

  test("the backfill sets the group key of older items once", async () => {
    const item = await clipWith({ source_url: "https://dedupe-e.test/old" });
    await ctx.testDb.db
      .update(intakeItems)
      .set({ group_key: null })
      .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.id, item.id)));
    const report = await runIntakeGroupKeyBackfill(ctx.testDb.db);
    expect(report.skipped).toBe(false);
    expect(report.grouped).toBeGreaterThanOrEqual(1);
    const [row] = await ctx.testDb.db
      .select({ group_key: intakeItems.group_key })
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.id, item.id)));
    expect(row?.group_key).toBe("site:dedupe-e.test");
    expect((await runIntakeGroupKeyBackfill(ctx.testDb.db)).skipped).toBe(true);
    await ctx.testDb.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.name, "intake_group_key_v1"));
  });
});
