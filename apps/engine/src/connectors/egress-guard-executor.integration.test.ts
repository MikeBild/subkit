import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { resolveTenantEgressContext } from "./egress-guard.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("egress-guard-executor");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

test("tenant origin is read through the executor the caller passes", async () => {
  const seen: { inside?: string | undefined; outside?: string | undefined } = {};
  await ctx.db.transaction(async (tx) => {
    const tenant = await seedTenant(tx, { slug: "egress-executor" });
    const inside = await resolveTenantEgressContext({
      tenant_id: tenant.id,
      exec: tx,
      mode: "permissive",
    });
    seen.inside = inside.mode;
    seen.outside = await resolveTenantEgressContext({
      tenant_id: tenant.id,
      exec: ctx.db,
      mode: "permissive",
    }).then(
      (resolved) => resolved.mode,
      (error: Error) => error.message,
    );
  });
  expect(seen).toEqual({ inside: "permissive", outside: "tenant_context_unavailable: " });
});
