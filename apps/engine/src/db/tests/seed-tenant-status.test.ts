import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { lockActiveTenant } from "../../identity/index.ts";
import {
  applyKnowledgeSeeds,
  applyKnowledgeSeedsForAllTenants,
  loadEmbeddedKnowledgeSeeds,
} from "../../knowledge/seed.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import {
  applySkillSeeds,
  applySkillSeedsForAllTenants,
  loadEmbeddedSkillSeeds,
} from "../../skills/seed.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { authIdentities, knowledgeSources, skills, tenants, users } from "../schema/index.ts";
import { seedTenantBootstrap } from "../seed.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;
let activeId: string;
const inactiveIds: string[] = [];
const skillSeeds = loadEmbeddedSkillSeeds().skills.slice(0, 1);
const knowledgeSeeds = loadEmbeddedKnowledgeSeeds().knowledge.slice(0, 1);

beforeAll(async () => {
  ctx = await createTestDb("seed-tenant-status");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  const [active] = await ctx.db
    .insert(tenants)
    .values({ slug: "seed-active", display_name: "Active" })
    .returning();
  if (!active) throw new Error("missing tenant");
  activeId = active.id;
  for (const state of ["suspended", "pending_deletion", "erased", "deleted"] as const) {
    const [identity] = await ctx.db
      .insert(authIdentities)
      .values({
        issuer_url: "https://identity.example.test",
        subject: `seed-${state}`,
        email: `${state}@example.test`,
      })
      .returning();
    if (!identity) throw new Error("missing identity");
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({
        slug: `seed-${state}`,
        display_name: state,
        origin: "self_service",
        owner_identity_id: identity.id,
        status: state === "deleted" ? "active" : state === "erased" ? "suspended" : state,
        deleted_at: state === "erased" || state === "deleted" ? new Date(FROZEN_NOW) : null,
        deletion_requested_at: state === "pending_deletion" ? new Date(FROZEN_NOW) : null,
        deletion_scheduled_for:
          state === "pending_deletion" ? new Date(FROZEN_NOW + 7 * 86400000) : null,
      })
      .returning();
    if (!tenant) throw new Error("missing tenant");
    inactiveIds.push(tenant.id);
  }
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

test("direct seed entry points refuse suspended, pending, erased and soft-deleted tenants", async () => {
  expect(skillSeeds).toHaveLength(1);
  expect(knowledgeSeeds).toHaveLength(1);
  for (const tenantId of inactiveIds) {
    await expect(applySkillSeeds(skillSeeds, tenantId, ctx.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    await expect(applyKnowledgeSeeds(knowledgeSeeds, tenantId, ctx.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    expect(await ctx.db.select().from(skills).where(eq(skills.tenant_id, tenantId))).toHaveLength(
      0,
    );
    expect(
      await ctx.db.select().from(knowledgeSources).where(eq(knowledgeSources.tenant_id, tenantId)),
    ).toHaveLength(0);
  }
});

test("all-tenant startup seeds visit only active undeleted tenants", async () => {
  expect(
    (await applySkillSeedsForAllTenants(skillSeeds, ctx.db)).map((row) => row.tenant_id),
  ).toEqual([activeId]);
  expect((await applyKnowledgeSeedsForAllTenants([], ctx.db)).map((row) => row.tenant_id)).toEqual([
    activeId,
  ]);
  for (const tenantId of inactiveIds) {
    expect(await ctx.db.select().from(skills).where(eq(skills.tenant_id, tenantId))).toHaveLength(
      0,
    );
    expect(
      await ctx.db.select().from(knowledgeSources).where(eq(knowledgeSources.tenant_id, tenantId)),
    ).toHaveLength(0);
  }
});

test("bootstrap cannot add users or keys to a hosted tenant with a matching slug", async () => {
  const roles = await seedBuiltinRolesAndPermissions(ctx.db);
  const [identity] = await ctx.db
    .insert(authIdentities)
    .values({
      issuer_url: "https://identity.example.test",
      subject: "bootstrap-owner",
      email: "owner@example.test",
    })
    .returning();
  if (!identity) throw new Error("missing identity");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: "bootstrap-hosted",
      display_name: "Hosted",
      origin: "self_service",
      owner_identity_id: identity.id,
    })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  await expect(
    seedTenantBootstrap(ctx.db, roles, {
      tenant_slug: tenant.slug,
      tenant_name: "Do not replace",
      admin_email: "intruder@example.test",
    }),
  ).rejects.toThrow("seed_bootstrap_requires_self_hosted_tenant");
  expect(await ctx.db.select().from(users).where(eq(users.tenant_id, tenant.id))).toHaveLength(0);
  const [saved] = await ctx.db.select().from(tenants).where(eq(tenants.id, tenant.id));
  expect(saved?.is_operator).toBe(false);
  expect(saved?.display_name).toBe("Hosted");
});

test("the active write lock prevents a concurrent suspension from passing the seed boundary", async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holder = ctx.db.transaction(async (tx) => {
    await lockActiveTenant(activeId, tx);
    entered();
    await stop;
  });
  await ready;
  const mutator = await ctx.pool.connect();
  try {
    const pid = (await mutator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!pid) throw new Error("missing backend pid");
    const update = mutator.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [
      activeId,
    ]);
    await waitFor(
      async () => {
        const result = await ctx.db.execute<{ blocked: boolean }>(
          sql`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`,
        );
        return result.rows[0]?.blocked === true;
      },
      { tries: 1000, sleepMs: 5 },
    );
    release();
    await holder;
    await update;
    await expect(applySkillSeeds(skillSeeds, activeId, ctx.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    const [saved] = await ctx.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, activeId), eq(skills.slug, skillSeeds[0]?.slug ?? "")));
    expect(saved).toBeDefined();
  } finally {
    release();
    await holder;
    mutator.release();
  }
});
