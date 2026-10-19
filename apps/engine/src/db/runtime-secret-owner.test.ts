import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { secretNames } from "../credentials/connections/service.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { createSecretVersion } from "../runtime-config/service.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { hostedQuotaError } from "./hosted-quota-errors.ts";
import { renderHostedQuotaSql } from "./hosted-quota-sql.ts";
import { runMigrations } from "./migrate.ts";
import { EMBEDDED_MIGRATIONS } from "./migrations/embedded.ts";
import { renderRuntimeSecretOwnershipSql } from "./runtime-secret-owner-sql.ts";
import { hostedTenantUsage, runtimeSecretVersions } from "./schema/index.ts";
import { createTestDb, type TestDb } from "./tests/setup.ts";

const migration = EMBEDDED_MIGRATIONS.find((item) =>
  item.tag.endsWith("_runtime_secret_ownership"),
);
const fixtures: TestDb[] = [];
afterAll(async () => {
  for (const fixture of fixtures) await fixture.cleanup();
});
async function previous(name: string) {
  if (!migration) throw new Error("owner migration missing");
  const fixture = await createTestDb(name, { upToIdx: migration.idx - 1 });
  fixtures.push(fixture);
  return fixture;
}
test("owner migration and embedded SQL match while initial quota installation retains its historical projection", () => {
  if (!migration) throw new Error("owner migration missing");
  const source = readFileSync(
    new URL(`./migrations/${migration.tag}.sql`, import.meta.url),
    "utf8",
  );
  expect(source).toBe(renderRuntimeSecretOwnershipSql());
  expect(createHash("sha256").update(source).digest("hex")).toBe(migration.hash);
  const initial = EMBEDDED_MIGRATIONS.find((item) => item.tag.endsWith("_hosted_resource_quota"));
  if (!initial) throw new Error("initial quota migration missing");
  const baseline = readFileSync(
    new URL(`./migrations/${initial.tag}.sql`, import.meta.url),
    "utf8",
  );
  expect(baseline).toBe(renderHostedQuotaSql());
  expect(baseline).not.toContain("hosted_meter_runtime_secret_versions");
});
test("forward upgrade binds historical revoked token ciphertext and adds only its exact retained usage", async () => {
  const fixture = await previous("secret-owner-upgrade");
  await configureHostedPolicyForTests(fixture.db, fixture.url);
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "secret-upgrade",
      email: "upgrade@example.test",
      email_verified: true,
    },
    fixture.db,
  );
  const name = secretNames(owned.tenant.id, "upgrade").access;
  await createSecretVersion(fixture.db, { name, value: "first-synthetic", created_by: null });
  await createSecretVersion(fixture.db, { name, value: "second-synthetic", created_by: null });
  await fixture.db.execute(
    sql`UPDATE subkit.runtime_secret_versions SET revoked_at=clock_timestamp() WHERE name=${name} AND version=1`,
  );
  await createSecretVersion(fixture.db, {
    name: "operator.upgrade-global",
    value: "operator",
    created_by: null,
  });
  const [before] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, owned.tenant.id));
  const expected = await fixture.db.execute<{ bytes: string }>(
    sql`SELECT sum(octet_length(name)+octet_length(ciphertext)+octet_length(iv)+octet_length(auth_tag))::text AS bytes FROM subkit.runtime_secret_versions WHERE name=${name}`,
  );
  await runMigrations(fixture.db, EMBEDDED_MIGRATIONS, true);
  const [after] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, owned.tenant.id));
  if (!before || !after) throw new Error("usage missing");
  expect(after.logical_bytes - before.logical_bytes).toBe(BigInt(expected.rows[0]!.bytes));
  expect(after.resource_counts).toEqual({
    ...before.resource_counts,
    runtime_secret_versions: "2",
  });
  const rows = await fixture.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name));
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.tenant_id === owned.tenant.id)).toBe(true);
  expect(rows[0]?.revoked_at).not.toBeNull();
  expect(
    (
      await fixture.db
        .select()
        .from(runtimeSecretVersions)
        .where(eq(runtimeSecretVersions.name, "operator.upgrade-global"))
    )[0]?.tenant_id,
  ).toBeNull();
});
for (const kind of ["malformed", "unknown_owner"] as const)
  test(`owner upgrade refuses ${kind} reserved names without deleting or adopting ciphertext`, async () => {
    const fixture = await previous(`secret-owner-${kind}`);
    const name =
      kind === "malformed"
        ? "connection.malformed.token.access_token"
        : "connection.01000000-0000-4000-8000-000000000001.token.access_token";
    await fixture.db.execute(
      sql`INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag) VALUES (${name},1,decode('01','hex'),decode('01','hex'),decode('01','hex'))`,
    );
    let failure: unknown;
    try {
      await runMigrations(fixture.db, EMBEDDED_MIGRATIONS, true);
    } catch (error) {
      failure = error;
    }
    expect(hostedQuotaError(failure)?.code).toBe("hosted_resource_write_rejected");
    expect(
      (
        await fixture.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM subkit.runtime_secret_versions WHERE name=${name}`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await fixture.db.execute(
          sql`SELECT 1 FROM information_schema.columns WHERE table_schema='subkit' AND table_name='runtime_secret_versions' AND column_name='tenant_id'`,
        )
      ).rows,
    ).toHaveLength(0);
  });
