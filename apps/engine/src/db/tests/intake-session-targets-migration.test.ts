import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { createTestDb } from "./setup.ts";

function targetMigration() {
  const migration = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) =>
      statement.includes('CREATE TABLE "subkit"."intake_item_evidence"'),
    ),
  );
  if (!migration) throw new Error("intake session target migration is not embedded");
  return migration;
}

test("intake target migration keeps admitted knowledge, provenance, and reviewed digests", async () => {
  const migration = targetMigration();
  const ctx = await createTestDb("intake_session_targets", { upToIdx: migration.idx - 1 });
  try {
    const nextId = createDeterministicUuidFactory(1_131);
    const tenantId = nextId();
    const actorId = nextId();
    const admittedItemId = nextId();
    const collectedItemId = nextId();
    const confirmedProposalId = nextId();
    const draftProposalId = nextId();
    const revisionId = nextId();
    const sourceId = nextId();
    const digest = "b".repeat(64);
    const target = { name: "Recording guidance", category: "audio" };
    const snapshot = {
      title: "Recording notes",
      source_url: "https://example.test/recording",
      captured_at: "2026-01-03T04:05:06.000Z",
      body: "Original source text",
      origin: "capture",
    };
    await ctx.pool.query(
      `INSERT INTO subkit.tenants (id, slug, display_name)
       VALUES ($1, 'intake-targets', 'Intake targets')`,
      [tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.knowledge_sources
        (id, tenant_id, name, slug, category, source_type, source_uri, version)
       VALUES ($1, $2, 'Recording guidance', 'recording-guidance', 'audio', 'bundle',
               'intake:recording', 'initial')`,
      [sourceId, tenantId],
    );
    for (const [id, state, admitted] of [
      [admittedItemId, "admitted", sourceId],
      [collectedItemId, "collected", null],
    ] as const) {
      await ctx.pool.query(
        `INSERT INTO subkit.intake_items
          (id, tenant_id, category, client_request_id, creation_request_digest, original_snapshot,
           title, body, state, version, collected_by_type, collected_by_id,
           admitted_knowledge_source_id)
         VALUES ($1, $2, 'inbox', $3, 'item-digest', $4::jsonb, 'Recording notes', 'Body',
                 $5, 3, 'user', $6, $7)`,
        [id, tenantId, nextId(), JSON.stringify(snapshot), state, actorId, admitted],
      );
    }
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposals
        (id, tenant_id, status, current_revision, confirmed_revision, confirmed_knowledge_source_id)
       VALUES ($1, $2, 'confirmed', 1, 1, $3), ($4, $2, 'draft', 1, NULL, NULL)`,
      [confirmedProposalId, tenantId, sourceId, draftProposalId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposal_revisions
        (id, tenant_id, proposal_id, revision, title, body, target, digest,
         created_by_type, created_by_id)
       VALUES ($1, $2, $3, 1, 'Recording guidance', 'Proposed knowledge', $4::jsonb, $5,
               'user', $6)`,
      [revisionId, tenantId, confirmedProposalId, JSON.stringify(target), digest, actorId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposal_items
        (tenant_id, proposal_revision_id, item_id, item_version, source_title, source_url)
       VALUES ($1, $2, $3, 3, 'Recording notes', 'https://example.test/recording')`,
      [tenantId, revisionId, admittedItemId],
    );

    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - migration.idx);

    await expect(
      ctx.pool.query(
        `SELECT id, state, admitted_target_kind, admitted_target_id, original_snapshot
           FROM subkit.intake_items WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: admittedItemId,
          state: "admitted",
          admitted_target_kind: "knowledge",
          admitted_target_id: sourceId,
          original_snapshot: snapshot,
        },
        {
          id: collectedItemId,
          state: "collected",
          admitted_target_kind: null,
          admitted_target_id: null,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    });
    await expect(
      ctx.pool.query(
        `SELECT id, confirmed_target_kind, confirmed_target_id
           FROM subkit.intake_proposals WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: confirmedProposalId,
          confirmed_target_kind: "knowledge",
          confirmed_target_id: sourceId,
        },
        { id: draftProposalId, confirmed_target_kind: null, confirmed_target_id: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    });
    await expect(
      ctx.pool.query(`SELECT target, digest FROM subkit.intake_proposal_revisions WHERE id = $1`, [
        revisionId,
      ]),
    ).resolves.toMatchObject({ rows: [{ target, digest }] });
    await expect(
      ctx.pool.query(
        `SELECT count(*)::int AS count FROM information_schema.columns
          WHERE table_schema = 'subkit'
            AND column_name IN ('admitted_knowledge_source_id', 'confirmed_knowledge_source_id')`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await ctx.pool.query(
      `INSERT INTO subkit.intake_proposal_items
        (tenant_id, proposal_revision_id, item_id, item_version, source_title, source_url)
       VALUES ($1, $2, $3, 3, 'Session learning', NULL)`,
      [tenantId, revisionId, collectedItemId],
    );
    await expect(
      ctx.pool.query(
        `UPDATE subkit.intake_items SET admitted_target_kind = 'skill' WHERE id = $1`,
        [collectedItemId],
      ),
    ).rejects.toThrow("intake_items_admitted_target_check");

    await ctx.pool.query(
      `INSERT INTO subkit.intake_item_evidence
        (tenant_id, item_id, agent, session_id, excerpt, captured_at,
         recorded_by_type, recorded_by_id)
       VALUES ($1, $2, 'codex', 'session-1', 'Evidence', now(), 'user', $3)`,
      [tenantId, collectedItemId, actorId],
    );
    await expect(
      ctx.pool.query(
        `INSERT INTO subkit.intake_item_evidence
          (tenant_id, item_id, agent, session_id, excerpt, captured_at,
           recorded_by_type, recorded_by_id)
         VALUES ($1, $2, 'codex', 'session-1', 'Replay', now(), 'user', $3)`,
        [tenantId, collectedItemId, actorId],
      ),
    ).rejects.toThrow("intake_item_evidence_item_session_key");
    await expect(
      ctx.pool.query(`UPDATE subkit.intake_item_evidence SET excerpt = 'changed'`),
    ).rejects.toThrow("append-only");
  } finally {
    await ctx.cleanup();
  }
});
