import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { _withDriverFetchForTests } from "../../../connectors/drivers/fetch-seam.ts";
import { _withEgressLookupForTests } from "../../../connectors/egress-guard.ts";
import { createDbFromUrl } from "../../../db/client.ts";
import { hostedQuotaError } from "../../../db/hosted-quota-errors.ts";
import {
  hostedTenantUsage,
  outboundConnectionStarts,
  runtimeSecretVersions,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../../identity/self-service.ts";
import { createSecretVersion, readSecretVersion } from "../../../runtime-config/service.ts";
import { eraseTenantRuntimeArtifacts } from "../../../runtime-config/tenant-erasure.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../../test-helpers/hosted-policy.ts";
import { completeConnection, secretNames } from "../service.ts";

let fixture: TestDb;
beforeAll(async () => {
  fixture = await createTestDb("connection-token-accounting");
  await configureHostedPolicyForTests(fixture.db, fixture.url);
});
afterAll(async () => fixture?.cleanup());
test("connection token histories charge all retained ciphertext and erase exact tenant versions", async () => {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "token-accounting",
      email: "token@example.test",
      email_verified: true,
    },
    fixture.db,
  );
  const tenantId = owned.tenant.id;
  const names = secretNames(tenantId, "quota-token");
  const measure = async () => {
    const [usage] = await fixture.db
      .select()
      .from(hostedTenantUsage)
      .where(eq(hostedTenantUsage.tenant_id, tenantId));
    const versions = await fixture.db
      .select()
      .from(runtimeSecretVersions)
      .where(inArray(runtimeSecretVersions.name, [names.access, names.refresh]));
    return {
      usage,
      versions,
      ciphertext: versions.reduce((n, row) => n + row.ciphertext.length, 0),
    };
  };
  const before = await measure();
  let connectionId: string | null = null;
  const fakeFetch = Object.assign(
    async () =>
      Response.json({
        access_token: "A".repeat(1048576),
        refresh_token: "R".repeat(1048576),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      }),
    { preconnect: () => {} },
  );
  for (let i = 0; i < 2; i++) {
    const state = `synthetic-state-${i}`;
    await fixture.db.insert(outboundConnectionStarts).values({
      tenant_id: tenantId,
      user_id: owned.membership.user_id,
      actor_type: "user",
      actor_id: owned.membership.user_id,
      owner_user_id: owned.membership.user_id,
      state_sha256: createHash("sha256").update(state).digest("hex"),
      code_verifier: "synthetic-verifier",
      redirect_uri: "https://engine.example.test/callback",
      connection_id: connectionId,
      name: "quota-token",
      base_url: "https://provider.example.test",
      issuer: "https://provider.example.test",
      authorization_endpoint: "https://provider.example.test/authorize",
      token_endpoint: "https://provider.example.test/token",
      client_id: "synthetic-client",
      scopes: ["read"],
      expires_at: new Date(getTestNow() + 600000),
    });
    const result = await _withEgressLookupForTests(
      async () => [{ address: "93.184.216.34", family: 4 }],
      () =>
        _withDriverFetchForTests(fakeFetch, () =>
          completeConnection(fixture.db, { state, code: "synthetic-code" }),
        ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("connection completion refused");
    connectionId = result.connection_id;
  }
  const after = await measure();
  expect(after.versions).toHaveLength(4);
  expect(after.versions.filter((row) => row.revoked_at !== null)).toHaveLength(2);
  expect(after.ciphertext).toBeGreaterThanOrEqual(4194304);
  expect(Number(after.usage!.logical_bytes - before.usage!.logical_bytes)).toBeGreaterThanOrEqual(
    after.ciphertext,
  );
  expect(after.usage!.resource_counts.runtime_secret_versions).toBe("4");
  await fixture.db.transaction((tx) => eraseTenantRuntimeArtifacts(tenantId, tx));
  const erased = await measure();
  expect(erased.versions).toHaveLength(0);
  expect(erased.usage!.resource_counts.runtime_secret_versions).toBe("0");
  expect(after.usage!.logical_bytes - erased.usage!.logical_bytes).toBeGreaterThanOrEqual(
    BigInt(after.ciphertext),
  );
});

async function owned(subject: string) {
  return provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    fixture.db,
  );
}
async function usage(tenantId: string) {
  const [row] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!row) throw new Error("usage missing");
  return row;
}
async function policy(bytes: string, rows = 1000) {
  await fixture.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${bytes}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${rows}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
}

test("exact full byte and version-count allowances reject token growth without ciphertext or canary retention", async () => {
  const connection = createDbFromUrl(fixture.url);
  try {
    const result = await owned("token-full");
    const tenantId = result.tenant.id;
    const name = secretNames(tenantId, "full").access;
    const baseline = await usage(tenantId);
    await policy(baseline.logical_bytes.toString());
    let failure: unknown;
    try {
      await createSecretVersion(connection.db, {
        name,
        value: "private-token-canary".repeat(100),
        created_by: null,
      });
    } catch (error) {
      failure = error;
    }
    expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
    expect(
      JSON.stringify({ message: failure instanceof Error ? failure.message : "" }),
    ).not.toContain("private-token-canary");
    expect(await usage(tenantId)).toEqual(baseline);
    expect(
      await fixture.db
        .select()
        .from(runtimeSecretVersions)
        .where(eq(runtimeSecretVersions.name, name)),
    ).toHaveLength(0);
    await policy("50000000", 2);
    await createSecretVersion(connection.db, { name, value: "first", created_by: null });
    await createSecretVersion(connection.db, { name, value: "second", created_by: null });
    let countFailure: unknown;
    try {
      await createSecretVersion(connection.db, {
        name,
        value: "third-private-token-canary",
        created_by: null,
      });
    } catch (error) {
      countFailure = error;
    }
    expect(hostedQuotaError(countFailure)?.code).toBe("hosted_resource_count_exhausted");
    expect((await usage(tenantId)).resource_counts.runtime_secret_versions).toBe("2");
    expect(
      await fixture.db
        .select()
        .from(runtimeSecretVersions)
        .where(eq(runtimeSecretVersions.name, name)),
    ).toHaveLength(2);
  } finally {
    await policy("50000000");
    await connection.pool.end();
  }
});

test("database enforces reserved namespace ownership, immutable binding and active token persistence", async () => {
  const result = await owned("token-owner-guards");
  const tenantId = result.tenant.id;
  const name = secretNames(tenantId, "guard").access;
  const version = await createSecretVersion(fixture.db, {
    name,
    value: "synthetic",
    created_by: null,
  });
  const [row] = await fixture.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name));
  expect(row?.tenant_id).toBe(tenantId);
  for (const mutation of [
    sql`UPDATE subkit.runtime_secret_versions SET tenant_id=NULL WHERE name=${name}`,
    sql`UPDATE subkit.runtime_secret_versions SET name='operator.renamed' WHERE name=${name}`,
    sql`UPDATE subkit.runtime_secret_versions SET version=version+1 WHERE name=${name}`,
    sql`INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag,tenant_id) VALUES ('operator.invalid-owner',1,decode('01','hex'),decode('01','hex'),decode('01','hex'),${tenantId}::uuid)`,
    sql`INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag) VALUES ('connection.malformed.access_token',1,decode('01','hex'),decode('01','hex'),decode('01','hex'))`,
  ]) {
    let failure: unknown;
    try {
      await fixture.db.execute(mutation);
    } catch (error) {
      failure = error;
    }
    expect(hostedQuotaError(failure)?.code).toBe("hosted_resource_write_rejected");
  }
  await fixture.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
  await expect(readSecretVersion(fixture.db, name, version.version)).rejects.toThrow(
    "known active workspace",
  );
  await expect(
    createSecretVersion(fixture.db, { name, value: "blocked", created_by: null }),
  ).rejects.toThrow("known active workspace");
  await fixture.db.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
});

test("operator globals stay unowned and self-hosted connection tokens remain readable", async () => {
  const result = await owned("token-global-control");
  const before = await usage(result.tenant.id);
  await createSecretVersion(fixture.db, {
    name: "operator.shared-fixture",
    value: "global",
    created_by: null,
  });
  const [global] = await fixture.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, "operator.shared-fixture"));
  expect(global?.tenant_id).toBeNull();
  expect(await usage(result.tenant.id)).toEqual(before);
  const [tenant] = await fixture.db
    .insert(tenants)
    .values({ slug: "token-selfhost", display_name: "Self hosted" })
    .returning();
  if (!tenant) throw new Error("tenant missing");
  const name = secretNames(tenant.id, "selfhost").access;
  const version = await createSecretVersion(fixture.db, {
    name,
    value: "selfhost-synthetic",
    created_by: null,
  });
  expect(await readSecretVersion(fixture.db, name, version.version)).toBe("selfhost-synthetic");
  expect(
    (
      await fixture.db
        .select()
        .from(runtimeSecretVersions)
        .where(eq(runtimeSecretVersions.name, name))
    )[0]?.tenant_id,
  ).toBe(tenant.id);
});

test("tenant secret erasure refuses operator-global references and pending global versions retain their format", async () => {
  const result = await owned("token-shared-reference");
  const name = secretNames(result.tenant.id, "shared").access;
  const stored = await createSecretVersion(fixture.db, {
    name,
    value: "synthetic",
    created_by: null,
  });
  await fixture.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{global_owned_reference}',to_jsonb(${stored.reference}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  try {
    await expect(
      fixture.db.transaction((tx) => eraseTenantRuntimeArtifacts(result.tenant.id, tx)),
    ).rejects.toThrow("tenant_erasure_shared_secret_reference");
    expect(
      await fixture.db
        .select()
        .from(runtimeSecretVersions)
        .where(eq(runtimeSecretVersions.name, name)),
    ).toHaveLength(1);
  } finally {
    await fixture.db.execute(
      sql`UPDATE subkit.runtime_config_revisions SET document=document-'global_owned_reference' WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
    );
  }
  const pending = await createSecretVersion(fixture.db, {
    name: "operator.pending-test",
    value: "pending-synthetic",
    created_by: null,
    pending: { prepared_by: "operator", bindings: ["llm.api_key"] },
  });
  const [row] = await fixture.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, pending.name));
  expect(row?.pending_since).not.toBeNull();
  expect(row?.pending_bindings).toEqual(["llm.api_key"]);
  expect(row?.tenant_id).toBeNull();
  await expect(readSecretVersion(fixture.db, pending.name, pending.version)).rejects.toThrow();
});
