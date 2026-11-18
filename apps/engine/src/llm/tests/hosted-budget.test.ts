import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { hostedBudgetReservations, llmUsage } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { recordUsage } from "../accounting/budget.ts";
import { reserveHostedBudget, settleHostedBudget } from "../accounting/hosted-budget.ts";

let fixture: TestDb;
let firstTenant: string;
let secondTenant: string;

beforeAll(async () => {
  fixture = await createTestDb("hosted_budget");
  await configureHostedPolicyForTests(fixture.db, fixture.url);
  const first = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "first",
      email: "first@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    fixture.db,
  );
  const second = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "second",
      email: "second@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    fixture.db,
  );
  firstTenant = first.tenant.id;
  secondTenant = second.tenant.id;
});

beforeEach(async () => {
  await fixture.db.delete(hostedBudgetReservations);
});

afterAll(async () => {
  await fixture?.cleanup();
});

function reserve(
  tenantId: string,
  requestKey: string,
  amount = 3n,
  tenantLimit = 10n,
  globalLimit = 100n,
) {
  return reserveHostedBudget(
    {
      tenant_id: tenantId,
      request_key: requestKey,
      currency: "USD",
      model: "provider:model",
      reserved_microunits: amount,
      tenant_limit_microunits: tenantLimit,
      global_limit_microunits: globalLimit,
    },
    fixture.db,
  );
}

test("concurrent provider attempts cannot overdraw a tenant monthly ceiling", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => reserve(firstTenant, `attempt-${index}`)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  const rows = await fixture.db
    .select()
    .from(hostedBudgetReservations)
    .where(eq(hostedBudgetReservations.tenant_id, firstTenant));
  expect(rows.reduce((sum, row) => sum + row.reserved_microunits, 0n)).toBe(9n);
});

test("concurrent tenants share the same atomic global money ceiling", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      reserve(index % 2 ? firstTenant : secondTenant, `global-${index}`, 3n, 100n, 10n),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
});

test("repeated reservation keys charge once and reject changed terms", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserve(firstTenant, "repeated")),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(new Set(results.map((result) => result.reservation.id)).size).toBe(1);
  await expect(reserve(firstTenant, "repeated", 4n)).rejects.toMatchObject({
    details: { reason: "reservation_conflict" },
  });
});

test("settlement refunds only the known unused amount and is exactly once", async () => {
  const { reservation } = await reserve(firstTenant, "settle", 8n);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      settleHostedBudget(firstTenant, reservation.id, 2n, fixture.db),
    ),
  );
  await expect(reserve(firstTenant, "next", 8n)).resolves.toMatchObject({ created: true });
  await expect(
    settleHostedBudget(firstTenant, reservation.id, 1n, fixture.db),
  ).rejects.toMatchObject({ details: { reason: "settlement_conflict" } });
});

test("unknown usage retains the reservation and foreign tenants cannot settle it", async () => {
  const { reservation } = await reserve(firstTenant, "uncertain", 10n);
  await expect(reserve(firstTenant, "after-timeout", 1n)).rejects.toMatchObject({
    details: { reason: "tenant_monthly_limit" },
  });
  await expect(
    settleHostedBudget(secondTenant, reservation.id, 0n, fixture.db),
  ).rejects.toMatchObject({ details: { reason: "reservation_not_found" } });
});

test("unexpected provider overrun is retained and blocks new global spending", async () => {
  const { reservation } = await reserve(firstTenant, "overrun", 3n);
  await expect(
    settleHostedBudget(firstTenant, reservation.id, 4n, fixture.db),
  ).rejects.toMatchObject({ details: { reason: "reservation_overrun" } });
  const [row] = await fixture.db
    .select()
    .from(hostedBudgetReservations)
    .where(eq(hostedBudgetReservations.id, reservation.id));
  expect(row?.state).toBe("reconciliation_required");
  expect(row?.reported_microunits).toBe(4n);
  await expect(reserve(secondTenant, "other")).rejects.toMatchObject({
    details: { reason: "reconciliation_required" },
  });
});

test("missing money policy fails closed instead of granting unlimited usage", async () => {
  await expect(reserve(firstTenant, "no-tenant-policy", 1n, 0n)).rejects.toThrow();
  await expect(reserve(firstTenant, "no-global-policy", 1n, 10n, 0n)).rejects.toThrow();
});

test("external reservation keys are opaque at rest while retries remain exactly once", async () => {
  const key = "user-content-never-persisted";
  const first = await reserve(firstTenant, key);
  const second = await reserve(firstTenant, key);
  expect(first.reservation.request_key).toBe(createHash("sha256").update(key).digest("hex"));
  expect(second.reservation.id).toBe(first.reservation.id);
  expect(second.created).toBe(false);
});

test("Hosted usage errors retain only a technical code while selfhost diagnostics remain", async () => {
  const selfhost = await seedTenant(fixture.db, {
    slug: "usage-selfhost",
    display_name: "Usage selfhost",
  });
  const error = "provider echoed private conversation input";
  for (const tenant_id of [firstTenant, selfhost.id]) {
    await recordUsage(
      {
        tenant_id,
        flow: "converse",
        model: "provider:model",
        prompt_tokens: 1,
        completion_tokens: 0,
        latency_ms: 1,
        result: "error",
        error,
      },
      fixture.db,
    );
  }
  const hosted = await fixture.db
    .select()
    .from(llmUsage)
    .where(eq(llmUsage.tenant_id, firstTenant));
  const hostedError = hosted.find((row) => row.result === "error");
  expect(hostedError?.error).toBe("provider_error");
  const [local] = await fixture.db
    .select()
    .from(llmUsage)
    .where(eq(llmUsage.tenant_id, selfhost.id));
  expect(local?.error).toBe(error);
  await expect(
    recordUsage(
      {
        tenant_id: firstTenant,
        flow: "converse",
        model: "injected free form content",
        prompt_tokens: 1,
        completion_tokens: 0,
        latency_ms: 1,
        result: "error",
        error,
      },
      fixture.db,
    ),
  ).rejects.toThrow();
});

test("direct SQL cannot persist arbitrary request payloads in the operational ledger", async () => {
  await expect(
    fixture.db
      .insert(hostedBudgetReservations)
      .values({
        tenant_id: firstTenant,
        request_key: "unhashed-user-content",
        month_bucket: "2000-01",
        currency: "USD",
        model: "provider:model",
        reserved_microunits: 1n,
        state: "reserved",
      })
      .execute(),
  ).rejects.toThrow();
  const [row] = await fixture.db
    .insert(llmUsage)
    .values({
      tenant_id: firstTenant,
      flow: "converse",
      model: "provider:model",
      result: "error",
      error: "raw-private-provider-echo",
      month_bucket: 200001,
    })
    .returning();
  expect(row?.error).toBe("provider_error");
  await expect(
    fixture.db
      .insert(llmUsage)
      .values({
        tenant_id: firstTenant,
        flow: "raw-user-content",
        model: "provider:model",
        result: "error",
        month_bucket: 200001,
      })
      .execute(),
  ).rejects.toThrow();
});
