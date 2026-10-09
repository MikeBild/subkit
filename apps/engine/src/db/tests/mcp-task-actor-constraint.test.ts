import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { normalizeMcpTaskActorConstraint } from "../normalize-mcp-task-actor-constraint.ts";
import { createTestDb } from "./setup.ts";

const migration = EMBEDDED_MIGRATIONS.find((entry) => entry.tag === "0089_decider_kind");
if (!migration) throw new Error("actor migration not embedded");
const pendingMigration = migration;

async function constraints(db: Db) {
  return (
    await db.execute(sql`
    SELECT oid::text AS oid, conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'subkit.mcp_tasks'::regclass ORDER BY conname
  `)
  ).rows;
}

async function journal(db: Db) {
  return (
    await db.execute(sql`
    SELECT id, hash, created_at, tag FROM subkit.__drizzle_migrations ORDER BY id
  `)
  ).rows;
}

async function seedActors(db: Db) {
  await db.execute(sql`
    INSERT INTO tenants (id, slug, display_name)
    VALUES ('10000000-0000-4000-8000-000000000001', 'actor-fixture', 'Actor Fixture');
    INSERT INTO users (id, tenant_id, email, role_id)
    SELECT '20000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000001', 'actor@example.com', id
      FROM roles WHERE name = 'admin' LIMIT 1;
    INSERT INTO conversations (id, tenant_id, status)
    VALUES ('30000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 'active');
    INSERT INTO mcp_tasks (id, tenant_id, conversation_id, turn_seq, kind, actor_id, result)
    VALUES ('40000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001', 1, 'start',
            '20000000-0000-4000-8000-000000000001', '{"preserved":true}'),
           ('40000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001', 2, 'start', NULL, '{"preserved":true}')
  `);
}

async function renameToAlias(db: Db) {
  await db.execute(sql`
    ALTER TABLE subkit.mcp_tasks RENAME CONSTRAINT mcp_tasks_actor_id_users_id_fk
    TO mcp_tasks_actor_id_fkey
  `);
}

describe("MCP task actor constraint compatibility", () => {
  test("normalizes the validated name without replacing its OID, rows or journal", async () => {
    const ctx = await createTestDb("actor_constraint_alias", { upToIdx: pendingMigration.idx - 1 });
    try {
      await seedActors(ctx.db);
      await renameToAlias(ctx.db);
      const before = await constraints(ctx.db);
      const beforeJournal = await journal(ctx.db);
      const rows = (await ctx.db.execute(sql`SELECT * FROM mcp_tasks ORDER BY id`)).rows;
      await ctx.db.transaction(normalizeMcpTaskActorConstraint);
      const after = await constraints(ctx.db);
      expect(after).toEqual(
        before
          .map((row) => ({
            ...row,
            name:
              row.name === "mcp_tasks_actor_id_fkey" ? "mcp_tasks_actor_id_users_id_fk" : row.name,
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      );
      expect((await ctx.db.execute(sql`SELECT * FROM mcp_tasks ORDER BY id`)).rows).toEqual(rows);
      expect(await journal(ctx.db)).toEqual(beforeJournal);
      await ctx.db.transaction(normalizeMcpTaskActorConstraint);
      expect(await constraints(ctx.db)).toEqual(after);
    } finally {
      await ctx.cleanup();
    }
  });

  for (const alias of [false, true]) {
    test(`upgrades ${alias ? "known alias" : "canonical"} actors with unchanged migration hashes`, async () => {
      const ctx = await createTestDb("actor_constraint_upgrade", {
        upToIdx: pendingMigration.idx - 1,
      });
      try {
        await seedActors(ctx.db);
        if (alias) await renameToAlias(ctx.db);
        const before = await journal(ctx.db);
        const data = (
          await ctx.db.execute(sql`SELECT id, actor_id, result FROM mcp_tasks ORDER BY id`)
        ).rows;
        const report = await runMigrations(ctx.db);
        expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - pendingMigration.idx);
        expect(report.hash_drift_backfilled).toBe(0);
        const after = await journal(ctx.db);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.find((row) => row.tag === pendingMigration.tag)?.hash).toBe(
          pendingMigration.hash,
        );
        expect(
          (await ctx.db.execute(sql`SELECT id, actor_id, result FROM mcp_tasks ORDER BY id`)).rows,
        ).toEqual(data);
        expect(
          (await ctx.db.execute(sql`SELECT actor_kind FROM mcp_tasks ORDER BY id`)).rows,
        ).toEqual([{ actor_kind: "user" }, { actor_kind: null }]);
        expect((await runMigrations(ctx.db)).applied).toBe(0);
      } finally {
        await ctx.cleanup();
      }
    });
  }

  test("rolls back the alias rename if a later migration statement fails", async () => {
    const ctx = await createTestDb("actor_constraint_rollback", {
      upToIdx: pendingMigration.idx - 1,
    });
    try {
      await seedActors(ctx.db);
      await renameToAlias(ctx.db);
      await ctx.db.execute(sql`ALTER TABLE subkit.mcp_tasks ADD COLUMN actor_kind text`);
      const before = await constraints(ctx.db);
      const beforeJournal = await journal(ctx.db);
      const beforeData = (await ctx.db.execute(sql`SELECT * FROM mcp_tasks ORDER BY id`)).rows;
      await expect(runMigrations(ctx.db)).rejects.toThrow();
      expect(await constraints(ctx.db)).toEqual(before);
      expect(await journal(ctx.db)).toEqual(beforeJournal);
      expect((await ctx.db.execute(sql`SELECT * FROM mcp_tasks ORDER BY id`)).rows).toEqual(
        beforeData,
      );
      expect(
        (
          await ctx.db.execute(sql`
            SELECT count(*)::int AS n FROM pg_catalog.pg_constraint
             WHERE conrelid = 'subkit.conversation_elicitations'::regclass
               AND conname = 'conversation_elicitations_decided_by_users_id_fk'
          `)
        ).rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await ctx.cleanup();
    }
  });

  const refused = [
    [
      "canonical constraint with wrong action",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE CASCADE",
    ],
    [
      "wrong source column",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (conversation_id) REFERENCES subkit.users(id) ON DELETE SET NULL",
    ],
    [
      "wrong match mode",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) MATCH FULL ON DELETE SET NULL",
    ],
    [
      "additional actor constraint",
      "ADD CONSTRAINT unexpected_actor_fk FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE SET NULL",
    ],
    [
      "wrong delete action",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE CASCADE",
    ],
    [
      "wrong update action",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE SET NULL ON UPDATE CASCADE",
    ],
    [
      "deferrable constraint",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE SET NULL DEFERRABLE",
    ],
    [
      "unvalidated constraint",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE SET NULL NOT VALID",
    ],
    [
      "name collision",
      "ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.users(id) ON DELETE SET NULL",
    ],
    [
      "unknown actor constraint",
      "RENAME CONSTRAINT mcp_tasks_actor_id_users_id_fk TO unexpected_actor_fk",
    ],
    [
      "wrong target",
      "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk, ADD CONSTRAINT mcp_tasks_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES subkit.tenants(id) ON DELETE SET NULL",
    ],
    ["missing constraint", "DROP CONSTRAINT mcp_tasks_actor_id_users_id_fk"],
  ] as const;
  for (const [name, mutation] of refused) {
    test(`refuses ${name} before changing rows, constraints or journal`, async () => {
      const ctx = await createTestDb("actor_constraint_refusal", {
        upToIdx: pendingMigration.idx - 1,
      });
      try {
        await ctx.db.execute(sql.raw(`ALTER TABLE subkit.mcp_tasks ${mutation}`));
        const before = await constraints(ctx.db);
        const beforeJournal = await journal(ctx.db);
        const elicitation = (
          await ctx.db.execute(sql`
          SELECT oid::text FROM pg_catalog.pg_constraint
           WHERE conrelid = 'subkit.conversation_elicitations'::regclass
             AND conname = 'conversation_elicitations_decided_by_users_id_fk'
        `)
        ).rows;
        await expect(runMigrations(ctx.db)).rejects.toThrow(
          "migration-mcp-task-actor-constraint-invalid",
        );
        expect(await constraints(ctx.db)).toEqual(before);
        expect(await journal(ctx.db)).toEqual(beforeJournal);
        expect(
          (
            await ctx.db.execute(sql`
          SELECT oid::text FROM pg_catalog.pg_constraint
           WHERE conrelid = 'subkit.conversation_elicitations'::regclass
             AND conname = 'conversation_elicitations_decided_by_users_id_fk'
        `)
          ).rows,
        ).toEqual(elicitation);
        expect(
          (
            await ctx.db.execute(sql`
          SELECT count(*)::int AS n FROM information_schema.columns
           WHERE table_schema = 'subkit' AND table_name = 'mcp_tasks' AND column_name = 'actor_kind'
        `)
          ).rows,
        ).toEqual([{ n: 0 }]);
      } finally {
        await ctx.cleanup();
      }
    });
  }
});
