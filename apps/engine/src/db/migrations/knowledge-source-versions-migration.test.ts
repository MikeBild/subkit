import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
  tenants,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;
const ids: Record<string, string> = {};

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0084_knowledge_source_versions");

async function runBackfill(): Promise<void> {
  if (!migration) throw new Error("migration 0084_knowledge_source_versions is not embedded");
  const backfill = migration.statements.filter((s) => /^\s*INSERT\b/i.test(s));
  expect(backfill).toHaveLength(1);
  for (const statement of backfill) await testDb.db.execute(sql.raw(statement));
}

async function seedSource(
  slug: string,
  source_type: string,
  chunks: { path: string | null; content: string }[],
  deleted = false,
): Promise<void> {
  const [row] = await testDb.db
    .insert(knowledgeSources)
    .values({
      tenant_id: tenantId,
      name: slug,
      slug,
      source_type,
      source_uri: source_type === "bundle" ? `${slug}.bundle.json` : `${slug}.md`,
      mime_type: source_type === "bundle" ? "application/json" : "text/markdown",
      version: `hash-${slug}`,
      ...(deleted ? { deleted_at: new Date() } : {}),
    })
    .returning();
  if (!row) throw new Error(`seed ${slug} failed`);
  ids[slug] = row.id;
  if (chunks.length === 0) return;
  await testDb.db.insert(knowledgeChunks).values(
    chunks.map((c, ordinal) => ({
      tenant_id: tenantId,
      knowledge_source_id: row.id,
      ordinal,
      path: c.path,
      content: c.content,
      byte_size: c.content.length,
      fingerprint: `${slug}-${ordinal}`,
    })),
  );
}

async function versionsOf(slug: string) {
  return testDb.db
    .select()
    .from(knowledgeSourceVersions)
    .where(eq(knowledgeSourceVersions.knowledge_source_id, ids[slug] ?? ""))
    .orderBy(asc(knowledgeSourceVersions.version));
}

beforeAll(async () => {
  testDb = await createTestDb("knowledge_source_versions_migration");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-knowledge-versions-migration", display_name: "versions" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;

  await seedSource("runbook", "inline", [
    { path: "runbook.md", content: "# Runbook" },
    { path: "runbook.md", content: "Page by phone." },
  ]);
  await seedSource("wiki", "bundle", [
    { path: "/a.md", content: "# A" },
    { path: null, content: "# Untitled" },
  ]);
  await seedSource("empty", "file_upload", []);
  await seedSource("gone", "inline", [{ path: null, content: "old" }], true);

  await runBackfill();
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0084 backfill — every live source starts with v1 of its current content", () => {
  test("a document becomes v1 with its chunks joined in order and the source hash", async () => {
    const [v1, ...rest] = await versionsOf("runbook");
    expect(rest).toHaveLength(0);
    expect(v1).toMatchObject({
      version: 1,
      tenant_id: tenantId,
      content_hash: "hash-runbook",
      author_user_id: null,
      author_system_account_id: null,
      note: null,
      content: {
        kind: "document",
        filename: "runbook.md",
        mime: "text/markdown",
        text: "# Runbook\n\nPage by phone.",
      },
    });
  });

  test("a bundle becomes v1 with one file per chunk, falling back to the slug path", async () => {
    const [v1] = await versionsOf("wiki");
    expect(v1?.content).toEqual({
      kind: "bundle",
      filename: "wiki.bundle.json",
      files: [
        { path: "/a.md", content: "# A" },
        { path: "/wiki.md", content: "# Untitled" },
      ],
    });
  });

  test("a source without chunks gets an empty v1 and a deleted source gets none", async () => {
    const [v1] = await versionsOf("empty");
    expect(v1?.content).toMatchObject({ kind: "document", text: "" });
    expect(await versionsOf("gone")).toHaveLength(0);
  });

  test("running the backfill again adds nothing", async () => {
    await runBackfill();
    const rows = await testDb.db
      .select({ c: sql<number>`count(*)::int` })
      .from(knowledgeSourceVersions)
      .where(eq(knowledgeSourceVersions.tenant_id, tenantId));
    expect(Number(rows[0]?.c)).toBe(3);
  });
});
