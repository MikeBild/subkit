import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { createTestDb, type TestDb } from "./setup.ts";

function cutoverMigration() {
  const migration = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) =>
      statement.includes("CREATE TEMPORARY TABLE intake_category_mapping"),
    ),
  );
  if (!migration) throw new Error("intake category cutover migration is not embedded");
  return migration;
}

async function createPreCutoverDb(label: string): Promise<TestDb> {
  const migration = cutoverMigration();
  return createTestDb(label, { upToIdx: migration.idx - 1 });
}

async function seedTenant(ctx: TestDb, tenantId: string): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO subkit.tenants (id, slug, display_name)
     VALUES ($1, 'intake-cutover', 'Intake cutover')`,
    [tenantId],
  );
}

test("intake category cutover preserves clips, provenance, defaults, and proposal references", async () => {
  const ctx = await createPreCutoverDb("intake_category_cutover");
  try {
    const nextId = createDeterministicUuidFactory(941);
    const tenantId = nextId();
    const actorId = nextId();
    const firstCollectionId = nextId();
    const secondCollectionId = nextId();
    const firstItemId = nextId();
    const secondItemId = nextId();
    const proposalId = nextId();
    const revisionId = nextId();
    const snapshot = {
      title: "Original recording notes",
      source_url: "https://example.test/recording",
      source_author: "Source author",
      published_at: "2026-01-02",
      captured_at: "2026-01-03T04:05:06.000Z",
      body: "Original source text",
      origin: "capture",
    };
    await seedTenant(ctx, tenantId);
    for (const collectionId of [firstCollectionId, secondCollectionId]) {
      await ctx.pool.query(
        `INSERT INTO subkit.intake_collections
          (id, tenant_id, name, creation_request_digest)
         VALUES ($1, $2, 'Inbox', 'collection-digest')`,
        [collectionId, tenantId],
      );
    }
    await ctx.pool.query(
      `INSERT INTO subkit.intake_collection_defaults
        (tenant_id, actor_type, actor_id, collection_id)
       VALUES ($1, 'user', $2, $3)`,
      [tenantId, actorId, firstCollectionId],
    );
    for (const [id, collectionId, title] of [
      [firstItemId, firstCollectionId, "Collected recording notes"],
      [secondItemId, secondCollectionId, "Second collected recording notes"],
    ] as const) {
      await ctx.pool.query(
        `INSERT INTO subkit.intake_items
          (id, tenant_id, collection_id, client_request_id, creation_request_digest,
           original_snapshot, title, body, note, state, version, collected_by_type, collected_by_id)
         VALUES ($1, $2, $3, $4, 'item-digest', $5::jsonb, $6, 'Edited intake text',
                 'Keep the source relation', 'reviewing', 7, 'user', $7)`,
        [id, tenantId, collectionId, nextId(), JSON.stringify(snapshot), title, actorId],
      );
    }
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposals (id, tenant_id, status, current_revision)
       VALUES ($1, $2, 'draft', 1)`,
      [proposalId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposal_revisions
        (id, tenant_id, proposal_id, revision, title, body, target, digest, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 1, 'Recording guidance', 'Proposed knowledge',
               '{"name":"Recording guidance","category":"audio"}'::jsonb,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'user', $4)`,
      [revisionId, tenantId, proposalId, actorId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposal_items
        (tenant_id, proposal_revision_id, item_id, item_version, source_title, source_url)
       VALUES ($1, $2, $3, 7, 'Collected recording notes', 'https://example.test/recording')`,
      [tenantId, revisionId, firstItemId],
    );

    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - cutoverMigration().idx);
    const items = await ctx.pool.query<{
      id: string;
      category: string;
      original_snapshot: typeof snapshot;
      state: string;
      version: number;
    }>(
      `SELECT id, category, original_snapshot, state, version
         FROM subkit.intake_items WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    expect(items.rows).toEqual([
      {
        id: firstItemId,
        category: "inbox",
        original_snapshot: snapshot,
        state: "reviewing",
        version: 7,
      },
      {
        id: secondItemId,
        category: "inbox",
        original_snapshot: snapshot,
        state: "reviewing",
        version: 7,
      },
    ]);
    await expect(
      ctx.pool.query(
        `SELECT category FROM subkit.intake_category_defaults
         WHERE tenant_id = $1 AND actor_type = 'user' AND actor_id = $2`,
        [tenantId, actorId],
      ),
    ).resolves.toMatchObject({ rows: [{ category: "inbox" }] });
    await expect(
      ctx.pool.query(
        `SELECT proposal_revision_id, item_id, item_version, source_title, source_url
         FROM subkit.intake_proposal_items WHERE tenant_id = $1`,
        [tenantId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          proposal_revision_id: revisionId,
          item_id: firstItemId,
          item_version: 7,
          source_title: "Collected recording notes",
          source_url: "https://example.test/recording",
        },
      ],
    });
    await expect(
      ctx.pool.query(`SELECT to_regclass('subkit.intake_collections') AS collection_table`),
    ).resolves.toMatchObject({ rows: [{ collection_table: null }] });
  } finally {
    await ctx.cleanup();
  }
});

test("intake category cutover refuses invalid and colliding collection names", async () => {
  for (const [label, names] of [
    ["intake_category_invalid", ["Überblick"]],
    ["intake_category_collision", ["Foo Bar", "foo-bar"]],
  ] as const) {
    const ctx = await createPreCutoverDb(label);
    try {
      const nextId = createDeterministicUuidFactory(label.length);
      const tenantId = nextId();
      await seedTenant(ctx, tenantId);
      for (const name of names) {
        await ctx.pool.query(
          `INSERT INTO subkit.intake_collections
            (id, tenant_id, name, creation_request_digest)
           VALUES ($1, $2, $3, 'collection-digest')`,
          [nextId(), tenantId, name],
        );
      }
      await expect(runMigrations(ctx.db)).rejects.toThrow("intake category cutover requires");
      await expect(
        ctx.pool.query(
          `SELECT count(*)::int AS count FROM subkit.intake_collections WHERE tenant_id = $1`,
          [tenantId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: names.length }] });
    } finally {
      await ctx.cleanup();
    }
  }
});
