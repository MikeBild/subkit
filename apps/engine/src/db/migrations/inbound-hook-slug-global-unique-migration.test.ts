import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { bindFromWorkflow, inboundSlugCandidate } from "../../webhooks/inbound/service.ts";
import type { Db } from "../client.ts";
import { runMigrations } from "../migrate.ts";
import { auditLog, webhooksInbound, workflows } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0086_inbound_hook_slug_global_unique");
const SHARED = "wf-webhook-to-slack";
const LONG = `wf-${"a".repeat(61)}`;
const UNSIGNED = { source: "generic", events: [], skip: true };

async function seedTenant(db: Db, label: string): Promise<string> {
  const {
    rows: [row],
  } = await db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${`slug-unique-${label}`}, ${`Slug unique ${label}`}) RETURNING id
  `);
  if (!row) throw new Error(`seed tenant ${label} failed`);
  return row.id;
}

async function seedWorkflow(db: Db, tenantId: string, slug: string): Promise<string> {
  const [row] = await db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active" })
    .returning({ id: workflows.id });
  if (!row) throw new Error(`seed workflow ${slug} failed`);
  return row.id;
}

async function seedHook(
  db: Db,
  hook: { tenantId: string; workflowId: string; slug: string; daysOld: number },
): Promise<string> {
  const [row] = await db
    .insert(webhooksInbound)
    .values({
      tenant_id: hook.tenantId,
      workflow_id: hook.workflowId,
      slug: hook.slug,
      verifier: "standard",
      native_verifier_config: UNSIGNED,
      secret_ciphertext: Buffer.from("seeded"),
      secret_iv: Buffer.from("seeded"),
      secret_auth_tag: Buffer.from("seeded"),
      origin: "trigger",
      created_at: sql`now() - make_interval(days => ${hook.daysOld})`,
      updated_at: sql`now() - make_interval(days => ${hook.daysOld})`,
    })
    .returning({ id: webhooksInbound.id });
  if (!row) throw new Error(`seed hook ${hook.slug} failed`);
  return row.id;
}

async function hookState(db: Db) {
  const rows = await db
    .select({
      id: webhooksInbound.id,
      slug: webhooksInbound.slug,
      updated_at: webhooksInbound.updated_at,
    })
    .from(webhooksInbound);
  return new Map(rows.map((r) => [r.id, r]));
}

async function reassignments(db: Db) {
  return await db
    .select({
      tenant_id: auditLog.tenant_id,
      resource_id: auditLog.resource_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(eq(auditLog.action, AuditAction.WEBHOOK_INBOUND_SLUG_REASSIGNED));
}

test(
  "0086 gives every later holder of a shared hook slug its own form and makes the slug globally unique",
  async () => {
    if (!migration)
      throw new Error("migration 0086_inbound_hook_slug_global_unique is not embedded");
    const ctx = await createTestDb("inbound_slug_global_unique", { upToIdx: migration.idx - 1 });
    try {
      const first = await seedTenant(ctx.db, "first");
      const second = await seedTenant(ctx.db, "second");
      const third = await seedTenant(ctx.db, "third");
      const bystander = await seedTenant(ctx.db, "bystander");
      const firstFlow = await seedWorkflow(ctx.db, first, "webhook-to-slack");
      const secondFlow = await seedWorkflow(ctx.db, second, "webhook-to-slack");
      const thirdFlow = await seedWorkflow(ctx.db, third, "webhook-to-slack");
      const firstLongFlow = await seedWorkflow(ctx.db, first, "long-flow");
      const secondLongFlow = await seedWorkflow(ctx.db, second, "long-flow");
      const bystanderFlow = await seedWorkflow(ctx.db, bystander, "bystander-flow");

      const thirdMarked = inboundSlugCandidate(SHARED, third, 1);
      const squatter = await seedHook(ctx.db, {
        tenantId: bystander,
        workflowId: bystanderFlow,
        slug: thirdMarked,
        daysOld: 5,
      });
      const oldest = await seedHook(ctx.db, {
        tenantId: first,
        workflowId: firstFlow,
        slug: SHARED,
        daysOld: 4,
      });
      const oldestLong = await seedHook(ctx.db, {
        tenantId: first,
        workflowId: firstLongFlow,
        slug: LONG,
        daysOld: 4,
      });
      const secondShared = await seedHook(ctx.db, {
        tenantId: second,
        workflowId: secondFlow,
        slug: SHARED,
        daysOld: 3,
      });
      const secondLong = await seedHook(ctx.db, {
        tenantId: second,
        workflowId: secondLongFlow,
        slug: LONG,
        daysOld: 3,
      });
      const thirdShared = await seedHook(ctx.db, {
        tenantId: third,
        workflowId: thirdFlow,
        slug: SHARED,
        daysOld: 2,
      });
      const before = await hookState(ctx.db);

      await runMigrations(ctx.db);

      const after = await hookState(ctx.db);
      for (const untouched of [squatter, oldest, oldestLong])
        expect(after.get(untouched)).toEqual(before.get(untouched));
      expect(after.get(secondShared)?.slug).toBe(inboundSlugCandidate(SHARED, second, 1));
      expect(after.get(secondLong)?.slug).toBe(inboundSlugCandidate(LONG, second, 1));
      expect(after.get(secondLong)?.slug.length).toBe(64);
      expect(after.get(thirdShared)?.slug).toBe(inboundSlugCandidate(SHARED, third, 2));
      expect(new Set([...after.values()].map((r) => r.slug)).size).toBe(after.size);

      const audited = await reassignments(ctx.db);
      expect(audited.map((a) => a.resource_id).sort()).toEqual(
        [secondShared, secondLong, thirdShared].sort(),
      );
      expect(audited.find((a) => a.resource_id === thirdShared)).toEqual({
        tenant_id: third,
        resource_id: thirdShared,
        metadata: {
          previous_slug: SHARED,
          slug: inboundSlugCandidate(SHARED, third, 2),
          workflow_id: thirdFlow,
        },
      });

      const indexes = await ctx.db.execute<{ indexname: string; indexdef: string }>(sql`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'webhooks_inbound' AND schemaname = current_schema()
           AND indexname <> 'webhooks_inbound_pkey'
      `);
      expect(indexes.rows.map((r) => r.indexname)).toEqual(["webhooks_inbound_slug_key"]);
      expect(indexes.rows[0]?.indexdef).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(slug\)$/);

      for (const statement of migration.statements) await ctx.db.execute(sql.raw(statement));
      expect(await hookState(ctx.db)).toEqual(after);
      expect((await reassignments(ctx.db)).length).toBe(3);

      const rebound = await bindFromWorkflow(
        {
          tenant_id: second,
          workflow_id: secondFlow,
          workflow_slug: "webhook-to-slack",
          trigger: { kind: "webhook", source: "generic", events: [], verify: "none" },
          actor_id: null,
        },
        ctx.db,
      );
      expect(rebound.status).toBe("noop");
      expect(rebound.row.slug).toBe(inboundSlugCandidate(SHARED, second, 1));
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
