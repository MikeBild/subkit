import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, count, eq } from "drizzle-orm";
import type { Actor } from "../../audit/actor.ts";
import { auditLog, knowledgeChunks, knowledgeSourceVersions } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { upsertKnowledgeBundle } from "../bundle-service.ts";
import { getKnowledgeSource } from "../catalog.ts";
import { KnowledgeVersionAlreadyCurrentError, KnowledgeVersionConflictError } from "../errors.ts";
import { createKnowledgeSource, deleteKnowledgeSource, ingestKnowledgeSource } from "../service.ts";
import { KNOWLEDGE_VERSIONS_KEPT, recordKnowledgeVersion } from "../version-record.ts";
import { getKnowledgeVersion, listKnowledgeHistory, restoreKnowledgeVersion } from "../versions.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0x6b20_30);

let ctx: KnowledgeTestCtx;
const editor: Actor = { kind: "user", id: nextUuid() };
const robot: Actor = { kind: "system_account", id: nextUuid() };

const FIRST = "# Runbook\n\nPage the on-call by phone at night.\n";
const SECOND =
  "# Runbook\n\nPage the on-call by phone at night.\n\n## Escalation\n\nCall the lead after 15 minutes.\n";

beforeAll(async () => {
  if (skip) return;
  ctx = await createKnowledgeTestCtx("versions");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

async function chunkTexts(knowledge_source_id: string): Promise<string[]> {
  const rows = await ctx.testDb.db
    .select({ content: knowledgeChunks.content })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, ctx.tenantId),
        eq(knowledgeChunks.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(asc(knowledgeChunks.ordinal));
  return rows.map((r) => r.content);
}

async function versionRows(knowledge_source_id: string) {
  return ctx.testDb.db
    .select()
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
        eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(asc(knowledgeSourceVersions.version));
}

describe.skipIf(skip)("knowledge versions", () => {
  let sourceId: string;
  let v1Chunks: string[];

  test("creating a source records v1 with its author and the exact content", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Runbook" },
        upload: {
          buffer: Buffer.from(FIRST, "utf8"),
          filename: "runbook.md",
          mime: "text/markdown",
        },
        actor: editor,
        source_type_override: "inline",
      },
      ctx.testDb.db,
    );
    sourceId = source.id;
    v1Chunks = await chunkTexts(sourceId);

    const page = await listKnowledgeHistory(ctx.tenantId, sourceId, {}, ctx.testDb.db);
    expect(page?.total).toBe(1);
    expect(page?.rows[0]).toMatchObject({
      version: 1,
      author: editor,
      note: null,
      current: true,
      content_hash: source.version,
    });
    const v1 = await getKnowledgeVersion(ctx.tenantId, sourceId, 1, ctx.testDb.db);
    expect(v1?.documents).toEqual([{ path: "runbook.md", content: FIRST }]);
  });

  test("a re-import with new content records v2; an identical one records nothing", async () => {
    const changed = await ingestKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: sourceId,
        upload: {
          buffer: Buffer.from(SECOND, "utf8"),
          filename: "runbook-escalation.md",
          mime: "text/markdown",
        },
        actor: robot,
      },
      ctx.testDb.db,
    );
    expect(changed.content_version).toBe(2);

    const same = await ingestKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: sourceId,
        upload: {
          buffer: Buffer.from(SECOND, "utf8"),
          filename: "runbook-escalation.md",
          mime: "text/markdown",
        },
        actor: editor,
      },
      ctx.testDb.db,
    );
    expect(same.content_version).toBeNull();

    const rows = await versionRows(sourceId);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]?.author_system_account_id).toBe(robot.id);
    expect(rows[1]?.author_user_id).toBeNull();

    const page = await listKnowledgeHistory(ctx.tenantId, sourceId, {}, ctx.testDb.db);
    expect(page?.rows.map((r) => [r.version, r.current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  test("restoring v1 records v3 with v1's content, the restorer, a note and an audit row", async () => {
    const restored = await restoreKnowledgeVersion(
      ctx.tenantId,
      sourceId,
      1,
      editor,
      ctx.testDb.db,
    );
    expect(restored?.version).toBe(3);
    expect(restored?.knowledge_source.source_uri).toBe("runbook.md");

    const rows = await versionRows(sourceId);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[2]?.content).toEqual(rows[0]?.content);
    expect(rows[2]?.content_hash).toBe(rows[0]?.content_hash);
    expect(rows[2]?.note).toBe("restored from v1");
    expect(rows[2]?.author_user_id).toBe(editor.id);
    expect(await chunkTexts(sourceId)).toEqual(v1Chunks);

    const source = await getKnowledgeSource(ctx.tenantId, sourceId, ctx.testDb.db);
    expect(source?.version).toBe(rows[0]?.content_hash);

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, sourceId),
          eq(auditLog.action, "knowledge_source.restored"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_type).toBe("user");
    expect(audits[0]?.actor_id).toBe(editor.id);
    expect(audits[0]?.metadata).toMatchObject({ restored_from: 1, new_version: 3 });
  });

  test("restoring the content that is already current is refused and records nothing", async () => {
    await expect(
      restoreKnowledgeVersion(ctx.tenantId, sourceId, 3, editor, ctx.testDb.db),
    ).rejects.toBeInstanceOf(KnowledgeVersionAlreadyCurrentError);
    await expect(
      restoreKnowledgeVersion(ctx.tenantId, sourceId, 1, editor, ctx.testDb.db),
    ).rejects.toBeInstanceOf(KnowledgeVersionAlreadyCurrentError);
    expect((await versionRows(sourceId)).length).toBe(3);
  });

  test("an ingest against a stale expected_version writes no version", async () => {
    await expect(
      ingestKnowledgeSource(
        {
          tenant_id: ctx.tenantId,
          knowledge_source_id: sourceId,
          expected_version: "stale",
          upload: { buffer: Buffer.from("# Other", "utf8"), filename: "runbook.md" },
          actor: editor,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    expect((await versionRows(sourceId)).length).toBe(3);
  });

  test("another tenant sees neither the history nor a version", async () => {
    const other = nextUuid();
    expect(await listKnowledgeHistory(other, sourceId, {}, ctx.testDb.db)).toBeNull();
    expect(await getKnowledgeVersion(other, sourceId, 1, ctx.testDb.db)).toBeNull();
    expect(await restoreKnowledgeVersion(other, sourceId, 1, editor, ctx.testDb.db)).toBeNull();
  });

  test("a bundle restores its files, not a flattened text", async () => {
    const files = [
      { path: "/a.md", content: "# A\n\nfirst" },
      { path: "/b.md", content: "# B\n\nsecond" },
    ];
    const created = await upsertKnowledgeBundle(
      { tenant_id: ctx.tenantId, actor: editor, input: { name: "Wiki" }, files },
      ctx.testDb.db,
    );
    const id = created.knowledge_source.id;
    const before = await chunkTexts(id);
    await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenantId,
        actor: editor,
        input: { name: "Wiki" },
        files: [{ path: "/a.md", content: "# A\n\nrewritten" }],
      },
      ctx.testDb.db,
    );
    const restored = await restoreKnowledgeVersion(ctx.tenantId, id, 1, robot, ctx.testDb.db);
    expect(restored?.version).toBe(3);
    expect(await chunkTexts(id)).toEqual(before);
    const v3 = await getKnowledgeVersion(ctx.tenantId, id, 3, ctx.testDb.db);
    expect(v3?.documents).toEqual(files);
    expect(v3?.author).toEqual(robot);
  });

  test("a source keeps only its newest versions, pruned as each new one is recorded", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Busy page" },
        upload: { buffer: Buffer.from("v1", "utf8"), filename: "busy.md", mime: "text/markdown" },
        actor: editor,
        source_type_override: "inline",
      },
      ctx.testDb.db,
    );
    for (let n = 2; n <= KNOWLEDGE_VERSIONS_KEPT + 2; n++) {
      await ctx.testDb.db.transaction((tx) =>
        recordKnowledgeVersion(tx, {
          tenant_id: ctx.tenantId,
          knowledge_source_id: source.id,
          content: { kind: "document", filename: "busy.md", mime: "text/markdown", text: `v${n}` },
          content_hash: `hash-${n}`,
          actor: editor,
          note: null,
        }),
      );
    }
    const rows = await versionRows(source.id);
    expect(rows).toHaveLength(KNOWLEDGE_VERSIONS_KEPT);
    expect(rows[0]?.version).toBe(3);
    expect(rows.at(-1)?.version).toBe(KNOWLEDGE_VERSIONS_KEPT + 2);
  });

  test("deleting a source deletes its versions", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Secret notes" },
        upload: {
          buffer: Buffer.from("token=abc", "utf8"),
          filename: "s.md",
          mime: "text/markdown",
        },
        actor: editor,
        source_type_override: "inline",
      },
      ctx.testDb.db,
    );
    expect(await versionRows(source.id)).toHaveLength(1);
    expect(await deleteKnowledgeSource(ctx.tenantId, source.id, null, ctx.testDb.db)).toBe(true);
    expect(await versionRows(source.id)).toHaveLength(0);
  });

  test("v1 restores once; restoring it again is a conflict that writes nothing", async () => {
    const source = await createKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        input: { name: "Before versions" },
        upload: {
          buffer: Buffer.from(FIRST, "utf8"),
          filename: "before.md",
          mime: "text/markdown",
        },
        actor: null,
        source_type_override: "inline",
      },
      ctx.testDb.db,
    );
    await ingestKnowledgeSource(
      {
        tenant_id: ctx.tenantId,
        knowledge_source_id: source.id,
        upload: {
          buffer: Buffer.from(SECOND, "utf8"),
          filename: "before.md",
          mime: "text/markdown",
        },
        actor: editor,
      },
      ctx.testDb.db,
    );
    const first = await restoreKnowledgeVersion(ctx.tenantId, source.id, 1, editor, ctx.testDb.db);
    expect(first?.version).toBe(3);

    const chunksBefore = await chunkTexts(source.id);
    const auditsBefore = await ctx.testDb.db
      .select({ c: count() })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, source.id)));
    await expect(
      restoreKnowledgeVersion(ctx.tenantId, source.id, 1, editor, ctx.testDb.db),
    ).rejects.toBeInstanceOf(KnowledgeVersionAlreadyCurrentError);
    expect((await versionRows(source.id)).map((r) => r.version)).toEqual([1, 2, 3]);
    expect(await chunkTexts(source.id)).toEqual(chunksBefore);
    const auditsAfter = await ctx.testDb.db
      .select({ c: count() })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, source.id)));
    expect(auditsAfter[0]?.c).toBe(auditsBefore[0]?.c);
  });
});
