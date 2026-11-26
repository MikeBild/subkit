import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TENANT_ROLE } from "../../../db/core/tenant-scope.ts";
import { connectors, tenants, vaultItems } from "../../../db/schema/index.ts";
import { ensureTenantRowSecurity, readTenantRoleFacts } from "../../../db/tenant-role-preflight.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../../db/tests/setup.ts";
import { POLL_INTERVAL_MS, waitForOAuthCredential } from "../wait.ts";

setDefaultTimeout(TEST_DB_HOOK_TIMEOUT);

const PLACEHOLDER = Buffer.from([0x01]);
const WAIT_MS = POLL_INTERVAL_MS * 2;
const listener = { on: () => {}, off: () => {} };

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("oauth_wait_row_scope");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-oauth-wait-scope", display_name: "OAuth Wait Scope" })
    .returning();
  tenant_id = tenant!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function connectorWithCredential(slug: string): Promise<string> {
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  await ctx.db.insert(vaultItems).values({
    tenant_id,
    connector_id: connector!.id,
    environment: "dev",
    mode: "oauth2",
    ciphertext: PLACEHOLDER,
    iv: PLACEHOLDER,
    auth_tag: PLACEHOLDER,
  });
  return connector!.id;
}

const waitFor = (connector_id: string) =>
  waitForOAuthCredential({
    tenant_id,
    connector_id,
    environment: "dev",
    timeout_ms: WAIT_MS,
    db: ctx.db,
    listener,
  });

describe("waitForOAuthCredential row scope on a superuser login", () => {
  test("the pooled credential read runs as the tenant role", async () => {
    expect((await readTenantRoleFacts(ctx.pool)).is_superuser).toBe(true);
    expect(await ensureTenantRowSecurity(ctx.pool)).toMatchObject({ verdict: "ready" });

    expect(await waitFor(await connectorWithCredential("oauth-scope-readable"))).toBe("succeeded");

    await ctx.pool.query(`REVOKE SELECT ON subkit.vault_items FROM ${TENANT_ROLE}`);
    expect(await waitFor(await connectorWithCredential("oauth-scope-revoked"))).toBe("timeout");
  });
});
