import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { createTestDb } from "./setup.ts";

const nextId = createDeterministicUuidFactory(0x73656c66);

test("self-service schema preserves existing tenants, users and provider bindings on upgrade", async () => {
  const migration = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) => statement.includes('CREATE TABLE "auth_identities"')),
  );
  if (!migration) throw new Error("self-service identity migration missing");
  const ctx = await createTestDb("self_service_upgrade", { upToIdx: migration.idx - 1 });
  const tenantId = nextId();
  const userId = nextId();
  try {
    await ctx.pool.query(
      "INSERT INTO subkit.tenants (id, slug, display_name, is_operator) VALUES ($1, 'operator-before-upgrade', 'Existing operator', true)",
      [tenantId],
    );
    await ctx.pool.query(
      "INSERT INTO subkit.users (id, tenant_id, email, role_id) SELECT $1, $2, 'existing@example.test', id FROM subkit.roles WHERE name = 'admin' AND tenant_id IS NULL",
      [userId, tenantId],
    );
    await ctx.pool.query(
      "INSERT INTO subkit.user_identities (tenant_id, user_id, provider_id, issuer_url, subject, email) VALUES ($1, $2, 'existing-provider', NULL, 'existing-subject', 'existing@example.test')",
      [tenantId, userId],
    );
    await runMigrations(ctx.db);
    const tenant = await ctx.pool.query(
      "SELECT origin, status, owner_identity_id, is_operator FROM subkit.tenants WHERE id = $1",
      [tenantId],
    );
    expect(tenant.rows).toEqual([
      { origin: "self_hosted", status: "active", owner_identity_id: null, is_operator: true },
    ]);
    const user = await ctx.pool.query(
      "SELECT auth_identity_id, status FROM subkit.users WHERE tenant_id = $1 AND id = $2",
      [tenantId, userId],
    );
    expect(user.rows).toEqual([{ auth_identity_id: null, status: "active" }]);
    const bindings = await ctx.pool.query(
      "SELECT issuer_url, subject FROM subkit.user_identities WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId],
    );
    expect(bindings.rows).toEqual([{ issuer_url: null, subject: "existing-subject" }]);
    const identities = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM subkit.auth_identities",
    );
    expect(identities.rows[0]?.count).toBe(0);
    expect((await runMigrations(ctx.db)).applied).toBe(0);
  } finally {
    await ctx.cleanup();
  }
});
