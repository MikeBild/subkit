import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { reserveHostedBudget } from "../llm/accounting/hosted-budget.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { now } from "../utils/clock.ts";
import { createMigrationDbFromUrl } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { EMBEDDED_MIGRATIONS } from "./migrations/embedded.ts";
import { catalogCategories, hostedBudgetReservations, hostedTenantUsage } from "./schema/index.ts";
import { createTestDb, type TestDb } from "./tests/setup.ts";

let fixture: TestDb | undefined;
afterAll(async () => {
  await fixture?.cleanup();
});

test("forward upgrade hashes raw request keys by migration provenance and backfills retained usage", async () => {
  const quotaMigration = EMBEDDED_MIGRATIONS.find((migration) =>
    migration.tag.endsWith("_hosted_resource_quota"),
  );
  if (!quotaMigration) throw new Error("quota migration missing");
  fixture = await createTestDb("hosted-quota-upgrade", { upToIdx: quotaMigration.idx - 1 });
  await configureHostedPolicyForTests(fixture.db, fixture.url);
  const result = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "quota-upgrade",
      email: "upgrade@example.test",
      email_verified: true,
    },
    fixture.db,
  );
  await fixture.db.insert(catalogCategories).values({
    tenant_id: result.tenant.id,
    name: "retained-before-upgrade",
    purpose: "retained user content",
  });
  const rawKeys = ["raw-request-key", "a".repeat(64)];
  const previous = await fixture.db
    .insert(hostedBudgetReservations)
    .values(
      rawKeys.map((request_key) => ({
        tenant_id: result.tenant.id,
        request_key,
        currency: "USD",
        model: "openai:fixture-model",
        month_bucket: new Date(now()).toISOString().slice(0, 7),
        reserved_microunits: 1n,
        state: "reserved" as const,
      })),
    )
    .returning();
  const migration = createMigrationDbFromUrl(fixture.url);
  try {
    await runMigrations(migration.db, EMBEDDED_MIGRATIONS, true);
  } finally {
    await migration.pool.end();
  }
  for (const [index, request_key] of rawKeys.entries()) {
    const retry = await reserveHostedBudget(
      {
        tenant_id: result.tenant.id,
        request_key,
        currency: "USD",
        model: "openai:fixture-model",
        reserved_microunits: 1n,
        tenant_limit_microunits: 10n,
        global_limit_microunits: 10n,
      },
      fixture.db,
    );
    expect(retry.created).toBe(false);
    expect(retry.reservation.id === previous[index]?.id).toBe(true);
  }
  const [usage] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, result.tenant.id));
  expect(usage?.logical_bytes).toBeGreaterThan(0n);
  expect(usage?.resource_counts.catalog_categories).toBe("1");
  expect(
    await fixture.db
      .select()
      .from(hostedBudgetReservations)
      .where(eq(hostedBudgetReservations.tenant_id, result.tenant.id)),
  ).toHaveLength(2);
});
