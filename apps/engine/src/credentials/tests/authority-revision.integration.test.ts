import { afterAll, beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  hasCredentialAuthorityRevisionColumn,
  resetSecretColumnDetection,
} from "../../runtime-config/secret-columns.ts";
import { getCredentialAuthorityMetadata } from "../authority-metadata.ts";
import { sameAuthorityScopes } from "../authority-scopes.ts";
import { getCredentialForConnector, rotateOAuth2Tokens, upsertCredential } from "../service.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("credential_authority_revision");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(database = ctx) {
  const slug = `credential-authority-${++counter}`;
  const [tenant] = await database.db
    .insert(tenants)
    .values({ slug, display_name: slug })
    .returning();
  if (!tenant) throw new Error("missing fixture tenant");
  const [connector] = await database.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
    })
    .returning();
  if (!connector) throw new Error("missing fixture connector");
  const input = {
    tenant_id: tenant.id,
    connector_id: connector.id,
    environment: "dev" as const,
    mode: "oauth2" as const,
    actor_id: null,
    value: {
      mode: "oauth2" as const,
      access_token: "fixture-token",
      token_type: "Bearer",
      scope: "read write",
    },
  };
  const credential = await upsertCredential(input, database.db);
  return { input, credential, tenant: tenant.id, connector: connector.id };
}

async function revision(id: string, database = ctx): Promise<number> {
  const rows = await database.pool.query<{ authority_revision: number }>(
    "SELECT authority_revision FROM subkit.credentials WHERE id=$1",
    [id],
  );
  const result = rows.rows[0]?.authority_revision;
  if (result === undefined) throw new Error("missing fixture credential");
  return result;
}

test("scope comparison preserves case and distinguishes unknown from an empty grant", () => {
  expect(sameAuthorityScopes("read write", " write read read ")).toBe(true);
  expect(sameAuthorityScopes("read write", "write,read")).toBe(true);
  expect(sameAuthorityScopes("read write", "read, write ,read")).toBe(true);
  expect(sameAuthorityScopes("read", "Read")).toBe(false);
  expect(sameAuthorityScopes(null, "")).toBe(false);
  expect(sameAuthorityScopes(null, null)).toBe(true);
});

test("ordinary refresh and omitted scopes preserve the credential authority identity", async () => {
  const f = await fixture();
  const refresh = { tenant_id: f.tenant, credential_id: f.credential.id, actor_id: null };
  await rotateOAuth2Tokens(
    { ...refresh, access_token: "refreshed", scope: "write read read" },
    ctx.db,
  );
  expect(await revision(f.credential.id)).toBe(1);
  await rotateOAuth2Tokens(
    { ...refresh, access_token: "refreshed-again", token_type: "bearer" },
    ctx.db,
  );
  expect(await revision(f.credential.id)).toBe(1);
  const value = await getCredentialForConnector(f.tenant, f.connector, "dev", ctx.db);
  expect(value?.value.mode).toBe("oauth2");
  if (value?.value.mode !== "oauth2") throw new Error("missing OAuth fixture");
  expect(value.value.access_token).toBe("refreshed-again");
  expect(value.value.scope).toBe("write read");
  expect(value.row.granted_scopes).toBe("write read");
});

test("a comma-separated grant is stored space-separated and is the same authority", async () => {
  const f = await fixture();
  await upsertCredential(
    { ...f.input, value: { ...f.input.value, scope: "read,write,read" } },
    ctx.db,
  );
  expect(await revision(f.credential.id)).toBe(1);
  let stored = await getCredentialForConnector(f.tenant, f.connector, "dev", ctx.db);
  if (stored?.value.mode !== "oauth2") throw new Error("missing OAuth fixture");
  expect(stored.value.scope).toBe("read write");
  expect(stored.row.granted_scopes).toBe("read write");

  await ctx.pool.query("UPDATE subkit.credentials SET granted_scopes=$1 WHERE id=$2", [
    "read,write",
    f.credential.id,
  ]);
  const refresh = { tenant_id: f.tenant, credential_id: f.credential.id, actor_id: null };
  await rotateOAuth2Tokens({ ...refresh, access_token: "refreshed", scope: "write, read" }, ctx.db);
  expect(await revision(f.credential.id)).toBe(1);
  stored = await getCredentialForConnector(f.tenant, f.connector, "dev", ctx.db);
  expect(stored?.row.granted_scopes).toBe("write read");
});

test("expanded, reduced, and changed authentication grants advance the authority revision", async () => {
  const f = await fixture();
  const refresh = {
    tenant_id: f.tenant,
    credential_id: f.credential.id,
    actor_id: null,
    access_token: "next",
  };
  await rotateOAuth2Tokens({ ...refresh, scope: "read write admin" }, ctx.db);
  expect(await revision(f.credential.id)).toBe(2);
  await rotateOAuth2Tokens({ ...refresh, scope: "" }, ctx.db);
  expect(await revision(f.credential.id)).toBe(3);
  await rotateOAuth2Tokens({ ...refresh, token_type: "DPoP" }, ctx.db);
  expect(await revision(f.credential.id)).toBe(4);
});

test("concurrent explicit replacements cannot lose authority revision increments", async () => {
  const f = await fixture();
  await Promise.all(
    ["replacement-a", "replacement-b", "replacement-c"].map((access_token) =>
      upsertCredential({ ...f.input, value: { ...f.input.value, access_token } }, ctx.db),
    ),
  );
  expect(await revision(f.credential.id)).toBe(4);
});

test("saving identical credential material does not invalidate its authority", async () => {
  const f = await fixture();
  await upsertCredential(f.input, ctx.db);
  expect(await revision(f.credential.id)).toBe(1);
  await upsertCredential(
    { ...f.input, value: { ...f.input.value, scope: "write read read" } },
    ctx.db,
  );
  expect(await revision(f.credential.id)).toBe(1);
  await upsertCredential(
    { ...f.input, value: { ...f.input.value, access_token: "different-identity" } },
    ctx.db,
  );
  expect(await revision(f.credential.id)).toBe(2);
});

test("a foreign tenant cannot refresh or rebind the credential", async () => {
  const owner = await fixture();
  const foreign = await fixture();
  await expect(
    rotateOAuth2Tokens(
      {
        tenant_id: foreign.tenant,
        credential_id: owner.credential.id,
        access_token: "foreign-token",
        scope: "admin",
        actor_id: null,
      },
      ctx.db,
    ),
  ).rejects.toThrow("unavailable");
  expect(await revision(owner.credential.id)).toBe(1);
  const metadata = await getCredentialAuthorityMetadata(
    foreign.tenant,
    owner.connector,
    "dev",
    ctx.db,
  );
  expect(metadata).toEqual({
    binding: { primary: null, client: null, connection: null },
    available: false,
  });
});

test("authority metadata neither exposes nor decrypts stored token material", async () => {
  const f = await fixture();
  const before = await getCredentialAuthorityMetadata(f.tenant, f.connector, "dev", ctx.db);
  expect(before.available).toBe(true);
  expect(before.binding.primary?.revision).toBe(1);
  expect(JSON.stringify(before)).not.toContain("fixture-token");
  await ctx.pool.query(
    "UPDATE subkit.credentials SET ciphertext=decode('00','hex') WHERE tenant_id=$1 AND id=$2",
    [f.tenant, f.credential.id],
  );
  expect(await getCredentialAuthorityMetadata(f.tenant, f.connector, "dev", ctx.db)).toEqual(
    before,
  );
});

test("deleted credentials are unavailable in both review and runtime without decryption", async () => {
  const f = await fixture();
  await ctx.pool.query(
    "UPDATE subkit.credentials SET deleted_at=clock_timestamp(), ciphertext=decode('00','hex') WHERE tenant_id=$1 AND id=$2",
    [f.tenant, f.credential.id],
  );
  const metadata = await getCredentialAuthorityMetadata(f.tenant, f.connector, "dev", ctx.db);
  expect(metadata.available).toBe(false);
  expect(metadata.binding.primary).toBeNull();
  expect(await getCredentialForConnector(f.tenant, f.connector, "dev", ctx.db)).toBeNull();
});

test("a failed audit rolls token, permission metadata and authority revision back together", async () => {
  const f = await fixture();
  await ctx.pool.query(`CREATE FUNCTION subkit.reject_rotation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'credential.rotated' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_rotation_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.reject_rotation_audit()`);
  try {
    await expect(
      rotateOAuth2Tokens(
        {
          tenant_id: f.tenant,
          credential_id: f.credential.id,
          access_token: "not-committed",
          scope: "admin",
          actor_id: null,
        },
        ctx.db,
      ),
    ).rejects.toMatchObject({ cause: { message: "fixture audit unavailable" } });
    expect(await revision(f.credential.id)).toBe(1);
    const read = await getCredentialForConnector(f.tenant, f.connector, "dev", ctx.db);
    if (read?.value.mode !== "oauth2") throw new Error("missing OAuth fixture");
    expect(read.value.access_token).toBe("fixture-token");
    expect(read.row.granted_scopes).toBe("read write");
  } finally {
    await ctx.pool.query(
      "DROP TRIGGER reject_rotation_audit ON subkit.audit_log; DROP FUNCTION subkit.reject_rotation_audit()",
    );
  }
});

test("an old schema remains writable and upgrades without granting any execution authority", async () => {
  const legacy = await createTestDb("credential_authority_upgrade", { upToIdx: 52 });
  try {
    await legacy.pool.query("CREATE TABLE public.credentials (authority_revision integer)");
    expect(await hasCredentialAuthorityRevisionColumn(legacy.db)).toBe(false);
    const f = await fixture(legacy);
    await upsertCredential(
      { ...f.input, value: { ...f.input.value, access_token: "legacy-replacement" } },
      legacy.db,
    );
    await runMigrations(legacy.db);
    resetSecretColumnDetection();
    expect(await hasCredentialAuthorityRevisionColumn(legacy.db)).toBe(true);
    expect(await revision(f.credential.id, legacy)).toBe(1);
    const read = await getCredentialForConnector(f.tenant, f.connector, "dev", legacy.db);
    if (read?.value.mode !== "oauth2") throw new Error("missing upgraded credential");
    expect(read.value.access_token).toBe("legacy-replacement");
    const authorities = await legacy.pool.query(
      "SELECT id FROM subkit.workflow_execution_authorities",
    );
    expect(authorities.rows).toHaveLength(0);
  } finally {
    await legacy.cleanup();
  }
});
