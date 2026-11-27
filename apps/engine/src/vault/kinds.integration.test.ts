import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { decryptSecret, encryptSecret, vaultItemAadV1, vaultItemAadV2 } from "../crypto/index.ts";
import { sessions, users, vaultItems } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { VAULT_PERMISSION, type VaultViewer } from "./core/vault-item.ts";
import { importVaultLogins } from "./persistence/import.ts";
import {
  decryptVaultItemValue,
  resolveVaultItemForUse,
  sessionAuthTime,
} from "./persistence/use.ts";
import {
  createVaultItem,
  getVaultItem,
  resolveVaultHandle,
  revealVaultItem,
  updateVaultItem,
  VaultError,
} from "./service.ts";

const PAN = "4111111111111111";
const nextId = createDeterministicUuidFactory(0x7a017);
const EXP_YEAR = new Date(getTestNow()).getUTCFullYear() + 2;

let ctx: TestDb;
let tenant_id: string;
let owner: string;
let colleague: string;
let admin: VaultViewer;

async function seedUser(email: string): Promise<string> {
  const role_id = await builtinRoleId(ctx.db, "member");
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id, email, role_id })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

function member(id: string): ResolvedPrincipal {
  return { ...adminPrincipal(tenant_id, id), roles: ["member"] };
}

async function sealedRow(id: string) {
  const [row] = await ctx.db
    .select({
      ciphertext: vaultItems.ciphertext,
      iv: vaultItems.iv,
      auth_tag: vaultItems.auth_tag,
      value_digest: vaultItems.value_digest,
      mode: vaultItems.mode,
    })
    .from(vaultItems)
    .where(eq(vaultItems.id, id));
  if (!row) throw new Error("row missing");
  return row;
}

async function caught(work: () => Promise<unknown>): Promise<VaultError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error("expected a VaultError");
}

function card(name: string, scope: "person" | "workspace" = "person") {
  return createVaultItem(ctx.db, {
    tenant_id,
    actor: { kind: "user", id: owner },
    viewer: admin,
    kind: "card",
    name,
    scope,
    environment: "prod",
    description: null,
    value: { kind: "card", number: PAN, exp_month: 4, exp_year: EXP_YEAR, holder: "Ada" },
  });
}

beforeAll(async () => {
  ctx = await createTestDb("vault_kinds");
  tenant_id = (await seedTenant(ctx.db, { slug: "vault-kinds", display_name: "Vault" })).id;
  owner = await seedUser("owner@kinds.test");
  colleague = await seedUser("colleague@kinds.test");
  admin = { user_id: owner, permissions: new Set(Object.values(VAULT_PERMISSION)) };
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

describe("cards", () => {
  test("a personal card shows brand, last 4 and expiry, sealed with the v2 binding", async () => {
    const created = await card("visa");
    expect(created).toMatchObject({
      kind: "card",
      scope: "person",
      metadata: { brand: "visa", last4: "1111", exp_month: 4, exp_year: EXP_YEAR },
      origins: [],
      fields: ["number", "exp_month", "exp_year", "holder"],
    });
    expect(JSON.stringify(created)).not.toContain(PAN);
    const row = await sealedRow(created.id);
    expect(row.mode).toBe("structured");
    expect(row.value_digest).toMatch(/^[0-9a-f]{64}$/);
    const plain = decryptSecret(
      row,
      vaultItemAadV2({ tenant_id, owner_user_id: owner, id: created.id, kind: "card" }),
    );
    expect(JSON.parse(plain)).toMatchObject({ number: PAN });
  });

  test("a card can't live in the workspace, neither through the service nor the table", async () => {
    expect((await caught(() => card("shared-visa", "workspace"))).code).toBe("invalid");
    const raw = encryptSecret("{}", "x");
    await expect(
      (async () =>
        ctx.db.insert(vaultItems).values({
          tenant_id,
          kind: "card",
          name: "direct-visa",
          environment: "prod",
          mode: "structured",
          ciphertext: Buffer.from(raw.ciphertext),
          iv: Buffer.from(raw.iv),
          auth_tag: Buffer.from(raw.auth_tag),
        }))(),
    ).rejects.toThrow();
  });

  test("revealing a card needs a sign-in younger than five minutes", async () => {
    const created = await card("reveal-visa");
    const base = { tenant_id, id: created.id, actor: null, viewer: admin };
    expect((await caught(() => revealVaultItem(ctx.db, base))).code).toBe("reauth_required");
    const stale = new Date(getTestNow() - 6 * 60 * 1000);
    expect((await caught(() => revealVaultItem(ctx.db, { ...base, auth_time: stale }))).code).toBe(
      "reauth_required",
    );
    const revealed = await revealVaultItem(ctx.db, { ...base, auth_time: new Date(getTestNow()) });
    expect(revealed.values).toMatchObject({ number: PAN, exp_month: "4" });
  });

  test("a card never goes into a connector step", async () => {
    await card("step-visa");
    const resolved = await resolveVaultHandle(ctx.db, {
      tenant_id,
      environment: "prod",
      user_id: owner,
      handle: { scope: "person", name: "step-visa", field: "number" },
    });
    expect(resolved).toMatchObject({ ok: false, code: "key_not_found" });
    expect(resolved.ok ? "" : resolved.message).toContain("is a card");
  });
});

describe("logins", () => {
  test("origins and one-time code key are kept; only a login takes https origins", async () => {
    const created = await createVaultItem(ctx.db, {
      tenant_id,
      actor: null,
      viewer: admin,
      kind: "login",
      name: "shop-login",
      scope: "workspace",
      environment: "prod",
      description: null,
      value: {
        kind: "login",
        username: "ada@shop",
        password: "pw-1",
        totp_seed: "JBSWY3DPEHPK3PXP",
      },
      origins: ["https://Shop.example/login"],
    });
    expect(created).toMatchObject({
      origins: ["https://shop.example"],
      metadata: { username_hint: "ad…", has_totp: true },
      fields: ["username", "password", "totp_seed"],
    });
    const rotated = await updateVaultItem(ctx.db, {
      tenant_id,
      id: created.id,
      actor: null,
      viewer: admin,
      value: { kind: "login_patch", password: "pw-2" },
      origins: ["https://shop.example", "https://checkout.shop.example"],
    });
    expect(rotated.metadata).toMatchObject({ has_totp: true });
    expect(rotated.origins).toEqual(["https://shop.example", "https://checkout.shop.example"]);
    const bad = await caught(() =>
      updateVaultItem(ctx.db, {
        tenant_id,
        id: created.id,
        actor: null,
        viewer: admin,
        origins: ["http://shop.example"],
      }),
    );
    expect(bad.code).toBe("invalid");
  });

  test("an old v1-sealed secret still opens and moves to v2 on rotation", async () => {
    const id = nextId();
    const sealed = encryptSecret(
      JSON.stringify({ token: "old-token" }),
      vaultItemAadV1(tenant_id, id),
    );
    await ctx.db.insert(vaultItems).values({
      id,
      tenant_id,
      kind: "secret",
      name: "legacy-token",
      environment: "prod",
      mode: "bearer",
      ciphertext: Buffer.from(sealed.ciphertext),
      iv: Buffer.from(sealed.iv),
      auth_tag: Buffer.from(sealed.auth_tag),
    });
    const handle = { scope: "workspace", name: "legacy-token", field: null } as const;
    const before = await resolveVaultHandle(ctx.db, {
      tenant_id,
      environment: "prod",
      user_id: owner,
      handle,
    });
    expect(before.ok && before.secret.value).toBe("old-token");
    await updateVaultItem(ctx.db, {
      tenant_id,
      id,
      actor: null,
      viewer: admin,
      value: { kind: "secret", token: "new-token" },
    });
    const row = await sealedRow(id);
    expect(() => decryptSecret(row, vaultItemAadV1(tenant_id, id))).toThrow();
    expect(
      decryptSecret(row, vaultItemAadV2({ tenant_id, owner_user_id: null, id, kind: "secret" })),
    ).toBe(JSON.stringify({ token: "new-token" }));
  });
});

describe("use", () => {
  test("the owner resolves a personal card; others never see it", async () => {
    const created = await card("use-visa");
    const used = await resolveVaultItemForUse(ctx.db, {
      tenant_id,
      principal: member(owner),
      name: "use-visa",
      kind: "card",
      environment: "prod",
    });
    expect(used).toMatchObject({ item_id: created.id, kind: "card", origins: [] });
    expect(used.value_digest).toBe((await sealedRow(created.id)).value_digest as string);
    const hidden = await caught(() =>
      resolveVaultItemForUse(ctx.db, {
        tenant_id,
        principal: member(colleague),
        name: "use-visa",
        kind: "card",
        environment: "prod",
      }),
    );
    expect(hidden.code).toBe("not_found");
    const wrongKind = await caught(() =>
      resolveVaultItemForUse(ctx.db, {
        tenant_id,
        principal: member(owner),
        name: "use-visa",
        kind: "login",
        environment: "prod",
      }),
    );
    expect(wrongKind.code).toBe("invalid");
  });

  test("a member may use a workspace login; the value opens only for the approved digest", async () => {
    const used = await resolveVaultItemForUse(ctx.db, {
      tenant_id,
      principal: member(colleague),
      name: "shop-login",
      kind: "login",
      environment: "prod",
    });
    expect(used.origins).toContain("https://shop.example");
    const value = await decryptVaultItemValue(ctx.db, {
      tenant_id,
      item_id: used.item_id,
      value_digest: used.value_digest,
    });
    expect(value).toMatchObject({ kind: "login", password: "pw-2" });
    const stale = await caught(() =>
      decryptVaultItemValue(ctx.db, {
        tenant_id,
        item_id: used.item_id,
        value_digest: "0".repeat(64),
      }),
    );
    expect(stale.code).toBe("conflict");
  });

  test("the auth time is the creation of the browser session", async () => {
    const [session] = await ctx.db
      .insert(sessions)
      .values({ tenant_id, user_id: owner, expires_at: new Date(getTestNow() + 60_000) })
      .returning({ id: sessions.id, created_at: sessions.created_at });
    if (!session) throw new Error("session fixture missing");
    const principal = { ...member(owner), session_id: session.id };
    expect((await sessionAuthTime(ctx.db, principal))?.getTime()).toBe(
      session.created_at.getTime(),
    );
    expect(await sessionAuthTime(ctx.db, member(owner))).toBeNull();
    await ctx.db
      .update(sessions)
      .set({ revoked_at: new Date(getTestNow()) })
      .where(and(eq(sessions.id, session.id), eq(sessions.tenant_id, tenant_id)));
    expect(await sessionAuthTime(ctx.db, principal)).toBeNull();
  });
});

describe("import", () => {
  const CSV = [
    "name,url,username,password,note",
    "Shop,https://shop.example,ada,pw,",
    "Mail,https://mail.example,ada,pw-mail,hi",
    "Broken,https://b.example,ada,,",
  ].join("\n");

  test("a dry run changes nothing; the import creates new logins and skips taken names", async () => {
    const input = {
      tenant_id,
      actor: null,
      viewer: admin,
      csv: CSV,
      scope: "person" as const,
      environment: "prod" as const,
    };
    const dry = await importVaultLogins(ctx.db, { ...input, dry_run: true });
    expect(dry.rows.map((row) => [row.name, row.status])).toEqual([
      ["shop", "create"],
      ["mail", "create"],
      ["Broken", "invalid"],
    ]);
    expect(dry.created).toBe(0);
    const done = await importVaultLogins(ctx.db, { ...input, dry_run: false });
    expect(done).toMatchObject({ created: 2, skipped: 0, invalid: 1 });
    const again = await importVaultLogins(ctx.db, { ...input, dry_run: false });
    expect(again).toMatchObject({ created: 0, skipped: 2 });
    const mail = done.rows.find((row) => row.name === "mail");
    expect(mail).toMatchObject({ origin: "https://mail.example", username_hint: "ad…" });
    expect(JSON.stringify(done)).not.toContain("pw-mail");
  });

  test("a workspace import needs vault:write", async () => {
    const reader = { user_id: colleague, permissions: new Set([VAULT_PERMISSION.read]) };
    const denied = await caught(() =>
      importVaultLogins(ctx.db, {
        tenant_id,
        actor: null,
        viewer: reader,
        csv: CSV,
        scope: "workspace",
        environment: "prod",
        dry_run: true,
      }),
    );
    expect(denied.code).toBe("forbidden");
    const item = await getVaultItem(ctx.db, tenant_id, (await card("last-visa")).id, admin);
    expect(item.kind).toBe("card");
  });
});
