import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { CredentialUseSnapshot } from "../credentials/index.ts";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { appendCredentialSnapshot } from "./credential-snapshots.ts";

let ctx: TestDb;
let tenantId: string;
let foreignTenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("credential_snapshots");
  const rows = await ctx.db
    .insert(tenants)
    .values([
      { slug: "snapshot-owner", display_name: "Snapshot owner" },
      { slug: "snapshot-foreign", display_name: "Foreign owner" },
    ])
    .returning();
  const owner = rows.find((row) => row.slug === "snapshot-owner");
  const foreign = rows.find((row) => row.slug === "snapshot-foreign");
  if (!owner || !foreign) throw new Error("snapshot tenants missing");
  tenantId = owner.id;
  foreignTenantId = foreign.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function snapshot(generation: number): CredentialUseSnapshot {
  return {
    connector_id: "10000000-0000-4000-8000-000000000001",
    environment: "prod",
    credential_id: "10000000-0000-4000-8000-000000000002",
    credential_generation: generation,
    connection_id: "10000000-0000-4000-8000-000000000003",
    access_token_version: generation + 4,
    identity: {
      issuer: "https://issuer.example.test",
      subject: `external-account-${generation}`,
      source: "token_endpoint",
    },
  };
}

async function step(owner = tenantId) {
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: owner,
      status: "running",
      request_source: "api",
      execution_mode: "prod",
      source_kind: "step",
    })
    .returning();
  if (!execution) throw new Error("snapshot execution missing");
  const [row] = await ctx.db
    .insert(executionSteps)
    .values({
      tenant_id: owner,
      execution_id: execution.id,
      step_key: "request",
      kind: "request",
      status: "running",
    })
    .returning();
  if (!row) throw new Error("snapshot step missing");
  return row;
}

async function stored(row: typeof executionSteps.$inferSelect) {
  const [result] = await ctx.db
    .select({ snapshots: executionSteps.credential_snapshots })
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, row.tenant_id), eq(executionSteps.id, row.id)));
  if (!result) throw new Error("stored snapshot step missing");
  return result.snapshots;
}

test("steps without observed credential use retain empty historical attribution", async () => {
  expect(await stored(await step())).toEqual([]);
});

test("concurrent credential observations preserve both generations without lost updates", async () => {
  const row = await step();
  const observations = [snapshot(1), snapshot(2)];
  await Promise.all(
    observations.map((value) =>
      appendCredentialSnapshot(ctx.db, tenantId, row.execution_id, row.id, value),
    ),
  );
  const actual = await stored(row);
  expect(actual).toHaveLength(2);
  expect(actual).toEqual(expect.arrayContaining(observations));
});

test("snapshot append requires the exact tenant execution and step tuple", async () => {
  const row = await step();
  const other = await step();
  const foreign = await step(foreignTenantId);
  const before = snapshot(1);
  await appendCredentialSnapshot(ctx.db, tenantId, row.execution_id, row.id, before);
  for (const target of [
    { tenant: foreignTenantId, execution: row.execution_id, id: row.id },
    { tenant: tenantId, execution: other.execution_id, id: row.id },
    { tenant: tenantId, execution: row.execution_id, id: other.id },
    { tenant: tenantId, execution: foreign.execution_id, id: foreign.id },
  ]) {
    await expect(
      appendCredentialSnapshot(ctx.db, target.tenant, target.execution, target.id, snapshot(2)),
    ).rejects.toThrow("credential snapshot step unavailable");
  }
  expect(await stored(row)).toEqual([before]);
  expect(await stored(other)).toEqual([]);
  expect(await stored(foreign)).toEqual([]);
});

test("invalid snapshot input fails before modifying an existing attribution history", async () => {
  const row = await step();
  const before = snapshot(1);
  await appendCredentialSnapshot(ctx.db, tenantId, row.execution_id, row.id, before);
  await expect(
    appendCredentialSnapshot(ctx.db, tenantId, row.execution_id, row.id, {
      ...snapshot(2),
      credential_generation: 0,
    }),
  ).rejects.toThrow();
  expect(await stored(row)).toEqual([before]);
});

test("persisted snapshots omit token material at every accepted object boundary", async () => {
  const row = await step();
  const value = snapshot(1);
  if (!value.identity) throw new Error("snapshot identity missing");
  const contaminated = {
    ...value,
    access_token: "fixture-access-secret",
    refresh_token: "fixture-refresh-secret",
    ciphertext: "fixture-ciphertext-secret",
    identity: {
      ...value.identity,
      client_secret: "fixture-client-secret",
      id_token: "fixture-id-token-secret",
    },
  };
  await appendCredentialSnapshot(ctx.db, tenantId, row.execution_id, row.id, contaminated);
  expect(await stored(row)).toEqual([value]);
});

test("later token observations and source-object mutation cannot rewrite earlier snapshots", async () => {
  const firstStep = await step();
  const secondStep = await step();
  const original = snapshot(1);
  const historical = snapshot(1);
  await appendCredentialSnapshot(ctx.db, tenantId, firstStep.execution_id, firstStep.id, original);
  original.credential_generation = 7;
  original.access_token_version = 11;
  if (!original.identity) throw new Error("snapshot identity missing");
  original.identity.subject = "replacement-account";
  await appendCredentialSnapshot(
    ctx.db,
    tenantId,
    secondStep.execution_id,
    secondStep.id,
    original,
  );
  await appendCredentialSnapshot(
    ctx.db,
    tenantId,
    firstStep.execution_id,
    firstStep.id,
    snapshot(2),
  );
  expect(await stored(firstStep)).toEqual([historical, snapshot(2)]);
  expect(await stored(secondStep)).toEqual([original]);
});
