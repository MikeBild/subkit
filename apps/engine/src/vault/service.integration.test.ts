import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  getTemplateOAuthCredentials,
  upsertTemplateOAuthCredentials,
} from "../connectors/template-credentials.ts";
import { upsertCredential } from "../credentials/service.ts";
import { auditLog, users, vaultItems } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { seedConnector, seedTenant } from "../test-helpers/seed.ts";
import { VAULT_PERMISSION, type VaultViewer } from "./core/vault-item.ts";
import {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  resolveVaultHandle,
  revealVaultItem,
  updateVaultItem,
  VaultError,
  vaultItemActivity,
  vaultViewer,
} from "./service.ts";

const TOKEN = "fixture-vault-token-7f3e91";
const ROTATED = "fixture-vault-token-rotated-2c4d";
const PASSWORD = "fixture-vault-password-a81b";

let ctx: TestDb;
let tenant_id: string;
let owner: string;
let colleague: string;
let admin: VaultViewer;
let reader: VaultViewer;

async function seedUser(email: string): Promise<string> {
  const role_id = await builtinRoleId(ctx.db, "member");
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id, email, role_id })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

async function storedText(): Promise<string> {
  const rows = await ctx.db.execute<{ dump: string }>(
    sql`SELECT coalesce(string_agg(a::text, ' '), '') AS dump FROM audit_log a WHERE a.tenant_id = ${tenant_id}`,
  );
  return rows.rows[0]?.dump ?? "";
}

beforeAll(async () => {
  ctx = await createTestDb("vault_service");
  tenant_id = (await seedTenant(ctx.db, { slug: "vault-service", display_name: "Vault" })).id;
  owner = await seedUser("owner@vault.test");
  colleague = await seedUser("colleague@vault.test");
  admin = { user_id: owner, permissions: new Set(Object.values(VAULT_PERMISSION)) };
  reader = { user_id: colleague, permissions: new Set([VAULT_PERMISSION.read]) };
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

describe("vault items", () => {
  test("a builtin admin holds every vault permission", async () => {
    const viewer = await vaultViewer(ctx.db, adminPrincipal(tenant_id, owner));
    expect([...viewer.permissions].sort()).toEqual(Object.values(VAULT_PERMISSION).sort());
    expect(viewer.user_id).toBe(owner);
  });

  test("a created secret lists with metadata only and a taken name is refused", async () => {
    const created = await createVaultItem(ctx.db, {
      tenant_id,
      actor: { kind: "user", id: owner },
      viewer: admin,
      kind: "secret",
      name: "crm-token",
      scope: "workspace",
      environment: "dev",
      description: "CRM API key",
      value: { kind: "secret", token: TOKEN },
    });
    expect(created).toMatchObject({
      name: "crm-token",
      kind: "secret",
      scope: "workspace",
      environment: "dev",
      version: 1,
      fields: ["token"],
      connector: null,
      last_used_at: null,
    });
    const listed = await listVaultItems(ctx.db, tenant_id, reader);
    expect(listed.map((item) => item.name)).toContain("crm-token");
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    await expect(
      createVaultItem(ctx.db, {
        tenant_id,
        actor: null,
        viewer: admin,
        kind: "secret",
        name: "crm-token",
        scope: "workspace",
        environment: "dev",
        description: null,
        value: { kind: "secret", token: "other" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("a reader cannot create, reveal or rotate workspace items", async () => {
    const [item] = await listVaultItems(ctx.db, tenant_id, reader, { kind: "secret" });
    if (!item) throw new Error("secret missing");
    await expect(
      revealVaultItem(ctx.db, { tenant_id, id: item.id, actor: null, viewer: reader }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      updateVaultItem(ctx.db, {
        tenant_id,
        id: item.id,
        actor: null,
        viewer: reader,
        value: { kind: "secret", token: "x" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createVaultItem(ctx.db, {
        tenant_id,
        actor: null,
        viewer: reader,
        kind: "secret",
        name: "not-mine",
        scope: "workspace",
        environment: "dev",
        description: null,
        value: { kind: "secret", token: "x" },
      }),
    ).rejects.toBeInstanceOf(VaultError);
  });

  test("a reveal returns the value and is audited without it", async () => {
    const [item] = await listVaultItems(ctx.db, tenant_id, admin, { kind: "secret" });
    if (!item) throw new Error("secret missing");
    const revealed = await revealVaultItem(ctx.db, {
      tenant_id,
      id: item.id,
      actor: { kind: "user", id: owner },
      viewer: admin,
    });
    expect(revealed.values).toEqual({ token: TOKEN });
    const activity = await vaultItemActivity(ctx.db, { tenant_id, id: item.id, viewer: admin });
    expect(activity.map((entry) => entry.action)).toEqual([
      "vault.item.revealed",
      "vault.item.created",
    ]);
    expect(await storedText()).not.toContain(TOKEN);
  });

  test("rotation raises the version and the next resolution injects the new value", async () => {
    const [item] = await listVaultItems(ctx.db, tenant_id, admin, { kind: "secret" });
    if (!item) throw new Error("secret missing");
    const rotated = await updateVaultItem(ctx.db, {
      tenant_id,
      id: item.id,
      actor: { kind: "user", id: owner },
      viewer: admin,
      value: { kind: "secret", token: ROTATED },
    });
    expect(rotated.version).toBe(2);
    expect(rotated.rotated_at).not.toBeNull();
    const resolved = await resolveVaultHandle(ctx.db, {
      tenant_id,
      environment: "dev",
      user_id: null,
      handle: { scope: "workspace", name: "crm-token", field: null },
      execution_id: null,
      step_id: "call",
    });
    expect(resolved).toMatchObject({ ok: true, secret: { value: ROTATED, version: 2 } });
    const after = await getVaultItem(ctx.db, tenant_id, item.id, admin);
    expect(after.last_used_at).not.toBeNull();
    const used = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "vault.item.used")));
    expect(used).toHaveLength(1);
    expect(used[0]?.metadata).toMatchObject({ name: "crm-token", version: 2, step_id: "call" });
    expect(await storedText()).not.toContain(ROTATED);
  });

  test("concurrent rotations audit the version each one produced", async () => {
    const created = await createVaultItem(ctx.db, {
      tenant_id,
      actor: { kind: "user", id: owner },
      viewer: admin,
      kind: "secret",
      name: "concurrent-token",
      scope: "workspace",
      environment: "dev",
      description: null,
      value: { kind: "secret", token: TOKEN },
    });
    expect(created.version).toBe(1);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM vault_items WHERE id = ${created.id} FOR UPDATE`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const rotating = Promise.all(
      [owner, colleague].map((actor_id) =>
        updateVaultItem(ctx.db, {
          tenant_id,
          id: created.id,
          actor: { kind: "user", id: actor_id },
          viewer: admin,
          value: { kind: "secret", token: `${ROTATED}-${actor_id}` },
        }),
      ),
    );
    const completed = Promise.allSettled([holder, rotating]);
    try {
      await waitFor(
        async () => {
          const result = await ctx.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update \"vault_items\"%'",
          );
          return Number(result.rows[0]?.count) === 2;
        },
        { label: "concurrent vault rotations", tries: 200 },
      );
    } finally {
      release.resolve();
      await completed;
    }
    await rotating;
    const current = await getVaultItem(ctx.db, tenant_id, created.id, admin);
    expect(current.version).toBe(3);
    const rotations = await ctx.db
      .select({ actor_id: auditLog.actor_id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.resource_id, created.id),
          eq(auditLog.action, "vault.item.rotated"),
        ),
      );
    expect(rotations).toHaveLength(2);
    expect(
      rotations.map((entry) => (entry.metadata as { version: number }).version).sort(),
    ).toEqual([2, 3]);
    expect(rotations.map((entry) => entry.actor_id).sort()).toEqual([owner, colleague].sort());
  });

  test("concurrent partial login rotations preserve both changes", async () => {
    const created = await createVaultItem(ctx.db, {
      tenant_id,
      actor: { kind: "user", id: owner },
      viewer: admin,
      kind: "login",
      name: "concurrent-login",
      scope: "workspace",
      environment: "dev",
      description: null,
      value: { kind: "login", username: "original-user", password: PASSWORD },
    });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM vault_items WHERE id = ${created.id} FOR UPDATE`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const rotating = Promise.all(
      [{ username: "rotated-user" }, { password: ROTATED }].map((patch) =>
        updateVaultItem(ctx.db, {
          tenant_id,
          id: created.id,
          actor: { kind: "user", id: owner },
          viewer: admin,
          value: { kind: "login_patch", ...patch },
        }),
      ),
    );
    const completed = Promise.allSettled([holder, rotating]);
    try {
      await waitFor(
        async () => {
          const result = await ctx.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%"vault_items"%'`,
          );
          return Number(result.rows[0]?.count) === 2;
        },
        { label: "concurrent partial login rotations", tries: 200 },
      );
    } finally {
      release.resolve();
      await completed;
    }
    await rotating;
    const revealed = await revealVaultItem(ctx.db, {
      tenant_id,
      id: created.id,
      actor: { kind: "user", id: owner },
      viewer: admin,
    });
    expect(revealed.values).toEqual({ username: "rotated-user", password: ROTATED });
    expect((await getVaultItem(ctx.db, tenant_id, created.id, admin)).version).toBe(3);
  });

  test("a handle resolves only in its environment", async () => {
    const resolved = await resolveVaultHandle(ctx.db, {
      tenant_id,
      environment: "prod",
      user_id: null,
      handle: { scope: "workspace", name: "crm-token", field: null },
    });
    expect(resolved).toMatchObject({ ok: false, code: "key_not_found" });
  });

  test("a personal login is invisible to others and resolves only for its owner", async () => {
    const login = await createVaultItem(ctx.db, {
      tenant_id,
      actor: { kind: "user", id: colleague },
      viewer: reader,
      kind: "login",
      name: "erp",
      scope: "person",
      environment: "dev",
      description: null,
      value: { kind: "login", username: "c.user", password: PASSWORD },
    });
    expect(login.scope).toBe("person");
    expect((await listVaultItems(ctx.db, tenant_id, admin)).map((i) => i.name)).not.toContain(
      "erp",
    );
    await expect(getVaultItem(ctx.db, tenant_id, login.id, admin)).rejects.toMatchObject({
      code: "not_found",
    });
    const own = await revealVaultItem(ctx.db, {
      tenant_id,
      id: login.id,
      actor: { kind: "user", id: colleague },
      viewer: reader,
    });
    expect(own.values).toEqual({ username: "c.user", password: PASSWORD });
    const handle = { scope: "person", name: "erp", field: "password" } as const;
    expect(
      await resolveVaultHandle(ctx.db, { tenant_id, environment: "dev", user_id: owner, handle }),
    ).toMatchObject({ ok: false, code: "key_not_found" });
    expect(
      await resolveVaultHandle(ctx.db, {
        tenant_id,
        environment: "dev",
        user_id: colleague,
        handle,
      }),
    ).toMatchObject({ ok: true, secret: { value: PASSWORD, secrets: [PASSWORD, PASSWORD] } });
    expect(
      await resolveVaultHandle(ctx.db, {
        tenant_id,
        environment: "dev",
        user_id: colleague,
        handle: { ...handle, field: null },
      }),
    ).toMatchObject({ ok: false, code: "key_not_found" });
  });

  test("a connector's credential is a named vault item that changes only on its connector", async () => {
    const connector = await seedConnector(ctx.db, {
      tenant_id,
      slug: "billing",
      environment: "dev",
      auth_type: "bearer",
    });
    await upsertCredential(
      {
        tenant_id,
        connector_id: connector.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "fixture-billing-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const [item] = await listVaultItems(ctx.db, tenant_id, admin, { kind: "connector" });
    expect(item).toMatchObject({
      name: "billing-dev-bearer",
      kind: "connector",
      connector: { id: connector.id, slug: "billing" },
    });
    if (!item) throw new Error("connector item missing");
    await expect(
      updateVaultItem(ctx.db, {
        tenant_id,
        id: item.id,
        actor: null,
        viewer: admin,
        description: "x",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const revealed = await revealVaultItem(ctx.db, {
      tenant_id,
      id: item.id,
      actor: null,
      viewer: admin,
    });
    expect(revealed.values).toEqual({ token: "fixture-billing-token" });
    await deleteVaultItem(ctx.db, { tenant_id, id: item.id, actor: null, viewer: admin });
    expect(await listVaultItems(ctx.db, tenant_id, admin, { kind: "connector" })).toEqual([]);
  });

  test("a template client is a vault item and still reads back", async () => {
    await upsertTemplateOAuthCredentials(
      {
        tenant_id,
        template_slug: "Acme CRM",
        value: { client_id: "client-1", client_secret: "fixture-template-secret" },
        actor_id: null,
      },
      ctx.db,
    );
    expect(await getTemplateOAuthCredentials(tenant_id, "Acme CRM", ctx.db)).toEqual({
      client_id: "client-1",
      client_secret: "fixture-template-secret",
    });
    const [item] = await listVaultItems(ctx.db, tenant_id, admin, { kind: "template_client" });
    expect(item).toMatchObject({ name: "template-acme-crm", template_slug: "Acme CRM" });
    if (!item) throw new Error("template item missing");
    const revealed = await revealVaultItem(ctx.db, {
      tenant_id,
      id: item.id,
      actor: null,
      viewer: admin,
    });
    expect(revealed.values).toEqual({
      client_id: "client-1",
      client_secret: "fixture-template-secret",
    });
  });

  test("deleting a secret removes its value", async () => {
    const [item] = await listVaultItems(ctx.db, tenant_id, admin, { kind: "secret" });
    if (!item) throw new Error("secret missing");
    await deleteVaultItem(ctx.db, { tenant_id, id: item.id, actor: null, viewer: admin });
    const rows = await ctx.db.select().from(vaultItems).where(eq(vaultItems.id, item.id));
    expect(rows).toEqual([]);
    const actions = (
      await ctx.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, item.id)))
    ).map((row) => row.action);
    expect(actions).toContain("vault.item.deleted");
  });
});
