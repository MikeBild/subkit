import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { seedConnector, seedTenant } from "../../test-helpers/seed.ts";
import { VAULT_PERMISSION, type VaultViewer } from "../../vault/core/vault-item.ts";
import {
  createVaultItem,
  listVaultItems,
  resolveVaultHandle,
  revealVaultItem,
} from "../../vault/service.ts";
import { createRowSecurityDb, type RowSecurityDb } from "./row-security-setup.ts";
import { TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

const ADMIN_VIEWER: VaultViewer = {
  user_id: null,
  permissions: new Set(Object.values(VAULT_PERMISSION)),
};

let rls: RowSecurityDb;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  rls = await createRowSecurityDb("tenant_row_security_services");
  tenantA = (await seedTenant(rls.owner.db, { slug: "row-security-svc-a" })).id;
  tenantB = (await seedTenant(rls.owner.db, { slug: "row-security-svc-b" })).id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await rls?.cleanup();
}, 30_000);

describe("services under forced row security for a plain owner", () => {
  test("the vault service stores, resolves and reveals only inside its tenant", async () => {
    const owner = rls.owner.db;
    const created = await createVaultItem(owner, {
      tenant_id: tenantA,
      actor: null,
      viewer: ADMIN_VIEWER,
      kind: "secret",
      name: "service-token",
      scope: "workspace",
      environment: "dev",
      description: null,
      value: { kind: "secret", token: "fixture-row-security-token" },
    });
    const handle = { scope: "workspace" as const, name: "service-token", field: null };
    expect(
      await resolveVaultHandle(owner, {
        tenant_id: tenantA,
        environment: "dev",
        user_id: null,
        handle,
      }),
    ).toMatchObject({ ok: true, secret: { value: "fixture-row-security-token" } });
    expect(
      await resolveVaultHandle(owner, {
        tenant_id: tenantB,
        environment: "dev",
        user_id: null,
        handle,
      }),
    ).toMatchObject({ ok: false, code: "key_not_found" });
    expect(
      await revealVaultItem(owner, {
        tenant_id: tenantA,
        id: created.id,
        actor: null,
        viewer: ADMIN_VIEWER,
      }),
    ).toMatchObject({ values: { token: "fixture-row-security-token" } });
    await expect(
      revealVaultItem(owner, {
        tenant_id: tenantB,
        id: created.id,
        actor: null,
        viewer: ADMIN_VIEWER,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await listVaultItems(owner, tenantB, ADMIN_VIEWER)).toEqual([]);
    expect((await listVaultItems(owner, tenantA, ADMIN_VIEWER)).map((i) => i.name)).toEqual([
      "service-token",
    ]);
  });

  test("connector credentials are written and read through the tenant scope", async () => {
    const owner = rls.owner.db;
    const connector = await seedConnector(owner, { tenant_id: tenantA, auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: tenantA,
        connector_id: connector.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "fixture-connector-token" },
        actor_id: null,
      },
      owner,
    );
    const own = await getCredentialForConnector(tenantA, connector.id, "dev", owner);
    expect(own?.value).toMatchObject({ mode: "bearer", token: "fixture-connector-token" });
    expect(await getCredentialForConnector(tenantB, connector.id, "dev", owner)).toBeNull();
  });
});
