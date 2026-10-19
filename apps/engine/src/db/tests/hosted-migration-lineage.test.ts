import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { createTestDb } from "./setup.ts";

const ids = createDeterministicUuidFactory(0x716d6967);

test("hosted upgrade preserves published credential modes and existing encrypted credentials", async () => {
  const published = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) => statement.includes("ADD VALUE 'signed_jwt'")),
  );
  const hosted = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) => statement.includes('CREATE TABLE "auth_identities"')),
  );
  if (!published || !hosted) throw new Error("required migration missing");
  expect(published.idx).toBeLessThan(hosted.idx);
  const fixture = await createTestDb("hosted-published-lineage", { upToIdx: published.idx });
  const tenant = ids();
  const connector = ids();
  const credential = ids();
  try {
    await fixture.pool.query(
      "INSERT INTO subkit.tenants(id,slug,display_name,is_operator) VALUES($1,'published-owner','Published owner',true)",
      [tenant],
    );
    await fixture.pool.query(
      "INSERT INTO subkit.connectors(id,tenant_id,slug,display_name,driver,auth_type) VALUES($1,$2,'published-connector','Published connector','http','signed_jwt')",
      [connector, tenant],
    );
    await fixture.pool.query(
      "INSERT INTO subkit.credentials(id,tenant_id,connector_id,environment,mode,ciphertext,iv,auth_tag) VALUES($1,$2,$3,'dev','signed_jwt',$4,$5,$6)",
      [
        credential,
        tenant,
        connector,
        Buffer.from([0, 255, 128]),
        Buffer.alloc(12, 17),
        Buffer.alloc(16, 23),
      ],
    );
    const before = (
      await fixture.pool.query("SELECT * FROM subkit.credentials WHERE id=$1", [credential])
    ).rows;
    const report = await runMigrations(fixture.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - published.idx - 1);
    expect(report.hash_drift_backfilled).toBe(0);
    expect(
      (await fixture.pool.query("SELECT * FROM subkit.credentials WHERE id=$1", [credential])).rows,
    ).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT auth_type FROM subkit.connectors WHERE id=$1 AND tenant_id=$2",
          [connector, tenant],
        )
      ).rows,
    ).toEqual([{ auth_type: "signed_jwt" }]);
    expect(
      (await fixture.pool.query("SELECT origin,status FROM subkit.tenants WHERE id=$1", [tenant]))
        .rows,
    ).toEqual([{ origin: "self_hosted", status: "active" }]);
    expect((await runMigrations(fixture.db)).applied).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});
