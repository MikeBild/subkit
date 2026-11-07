import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { AuditAction } from "../audit/index.ts";
import { getConfig, isConfigLoaded, setConfigKey } from "../config/loader.ts";
import { auditLog, userIdentities, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { bindProviderIdentity, ProviderIdentityBindingError } from "./provider-identities.ts";

let tdb: TestDb;
const clock = createDeterministicClock();
let previousClock: ReturnType<typeof installClock>;
let priorProviders: unknown;
let homeTenantId = "";
let foreignTenantId = "";
const CORP_ISSUER = "https://corp-idp.example.test";
const APP_ISSUER = "https://app-idp.example.test";
const ACTOR = "00000000-0000-4000-8000-0000000000ac";

beforeAll(async () => {
  previousClock = installClock(clock);
  tdb = await createTestDb("provider-identities");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  priorProviders = getConfig().auth.providers;
  await setConfigKey(
    "auth.providers",
    [
      { protocol: "api_key", id: "api-key", label: "API key" },
      {
        protocol: "oidc",
        id: "corp-sso",
        label: "Corp SSO",
        issuer_url: CORP_ISSUER,
        client_id: "corp-client",
        tenant_slug: "bind-home",
      },
      {
        protocol: "oidc",
        id: "app-sso",
        label: "App SSO",
        issuer_url: APP_ISSUER,
        client_id: "app-client",
        tenant_slug: "bind-home",
        product_id: "app-one",
      },
    ],
    { force: true },
  );
  homeTenantId = (await seedTenant(tdb.db, { slug: "bind-home" })).id;
  foreignTenantId = (await seedTenant(tdb.db, { slug: "bind-foreign" })).id;
});
afterAll(async () => {
  if (isConfigLoaded()) await setConfigKey("auth.providers", priorProviders, { force: true });
  restoreClock(previousClock);
  await tdb.cleanup();
});

async function seedUser(
  label: string,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const tenant_id = overrides.tenant_id ?? homeTenantId;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: `${label}@example.test`,
      role_id: await emptyRoleId(tdb.db, tenant_id),
      ...overrides,
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

async function seedBinding(
  values: Partial<typeof userIdentities.$inferInsert> & { user_id: string },
) {
  const [row] = await tdb.db
    .insert(userIdentities)
    .values({
      tenant_id: homeTenantId,
      provider_id: "corp-sso",
      subject: "seeded-subject",
      email: "seeded@example.test",
      ...values,
    })
    .returning();
  if (!row) throw new Error("binding fixture missing");
  return row;
}

function bind(user_id: string, subject: string, overrides: Record<string, unknown> = {}) {
  return bindProviderIdentity(
    {
      tenant_id: homeTenantId,
      user_id,
      provider_id: "corp-sso",
      subject,
      actor_id: ACTOR,
      actor_kind: "user",
      request_source: "api",
      ...overrides,
    },
    tdb.db,
  );
}

async function bindingsOf(user_id: string) {
  return tdb.db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.tenant_id, homeTenantId), eq(userIdentities.user_id, user_id)));
}

async function linkAudits(resource_id: string) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, homeTenantId),
        eq(auditLog.action, AuditAction.USER_IDENTITY_LINKED),
        eq(auditLog.resource_id, resource_id),
      ),
    );
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ProviderIdentityBindingError)) throw new Error("expected a refusal");
  return error.code;
}

describe("binding a provider identity", () => {
  test("a first binding stores the provider's issuer and audits the link", async () => {
    const user_id = await seedUser("bind-first");

    const result = await bind(user_id, "subject-first");

    expect(result.replayed).toBe(false);
    expect(result.binding.user_id).toBe(user_id);
    expect(result.binding.provider_id).toBe("corp-sso");
    expect(result.binding.issuer_url).toBe(CORP_ISSUER);
    expect(result.binding.product_id).toBeNull();
    expect(result.binding.subject).toBe("subject-first");
    expect(result.binding.email).toBe("bind-first@example.test");
    const [event] = await linkAudits(result.binding.id);
    expect(event?.actor_type).toBe("user");
    expect(event?.actor_id).toBe(ACTOR);
    expect(event?.resource_type).toBe("user_identity");
    expect(event?.result).toBe("success");
    expect(event?.metadata).toEqual({
      user_id,
      provider_id: "corp-sso",
      issuer_url: CORP_ISSUER,
      product_id: null,
      request_source: "api",
      legacy_pin: false,
    });
  });

  test("a product provider binds the identity to its product", async () => {
    const user_id = await seedUser("bind-product");

    const result = await bind(user_id, "subject-product", {
      provider_id: "app-sso",
      actor_kind: "system_account",
      request_source: "cli",
    });

    expect(result.binding.product_id).toBe("app-one");
    expect(result.binding.issuer_url).toBe(APP_ISSUER);
    const [event] = await linkAudits(result.binding.id);
    expect(event?.actor_type).toBe("system_account");
    expect(event?.metadata).toMatchObject({ product_id: "app-one", request_source: "cli" });
  });

  test("repeating the same binding replays it without a second audit row", async () => {
    const user_id = await seedUser("bind-replay");
    const first = await bind(user_id, "subject-replay");

    const second = await bind(user_id, "subject-replay");

    expect(second.replayed).toBe(true);
    expect(second.binding.id).toBe(first.binding.id);
    expect(await linkAudits(first.binding.id)).toHaveLength(1);
    expect(await bindingsOf(user_id)).toHaveLength(1);
  });

  test("a legacy binding without issuer is pinned to the provider and audited as a pin", async () => {
    const user_id = await seedUser("bind-legacy");
    const legacy = await seedBinding({ user_id, subject: "subject-legacy", issuer_url: null });
    const at = clock.advanceBy(1000);

    const result = await bind(user_id, "subject-legacy");

    expect(result.replayed).toBe(false);
    expect(result.binding.id).toBe(legacy.id);
    expect(result.binding.issuer_url).toBe(CORP_ISSUER);
    expect(result.binding.product_id).toBeNull();
    expect(result.binding.updated_at.getTime()).toBe(at);
    const [event] = await linkAudits(legacy.id);
    expect(event?.metadata).toMatchObject({ legacy_pin: true, issuer_url: CORP_ISSUER });
  });

  test("a legacy binding of a product provider is pinned to that product", async () => {
    const user_id = await seedUser("bind-legacy-product");
    const legacy = await seedBinding({
      user_id,
      provider_id: "app-sso",
      subject: "subject-legacy-product",
      issuer_url: null,
      product_id: null,
    });

    const result = await bind(user_id, "subject-legacy-product", { provider_id: "app-sso" });

    expect(result.binding.id).toBe(legacy.id);
    expect(result.binding.product_id).toBe("app-one");
    expect(result.binding.issuer_url).toBe(APP_ISSUER);
  });

  test("the same subject in another tenant does not block the binding", async () => {
    const foreignUser = await seedUser("bind-foreign-owner", { tenant_id: foreignTenantId });
    await seedBinding({
      tenant_id: foreignTenantId,
      user_id: foreignUser,
      subject: "subject-shared",
      issuer_url: CORP_ISSUER,
    });
    const user_id = await seedUser("bind-shared");

    const result = await bind(user_id, "subject-shared");

    expect(result.replayed).toBe(false);
    expect(result.binding.tenant_id).toBe(homeTenantId);
  });
  test("parallel identical bindings create one row and replay the rest", async () => {
    const user_id = await seedUser("bind-parallel");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => bind(user_id, "subject-parallel")),
    );

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.binding.id)).size).toBe(1);
    expect(await bindingsOf(user_id)).toHaveLength(1);
  });

  test("an unpinned binding that already carries the provider's product is pinned to its issuer", async () => {
    const user_id = await seedUser("bind-legacy-same-product");
    const legacy = await seedBinding({
      user_id,
      provider_id: "app-sso",
      subject: "subject-legacy-same-product",
      issuer_url: null,
      product_id: "app-one",
    });

    const result = await bind(user_id, "subject-legacy-same-product", { provider_id: "app-sso" });

    expect(result.binding.id).toBe(legacy.id);
    expect(result.binding.issuer_url).toBe(APP_ISSUER);
    expect(result.replayed).toBe(false);
  });
});

describe("refusing a provider identity binding", () => {
  test("an unknown provider is unavailable", async () => {
    const user_id = await seedUser("refuse-unknown");

    expect(await refusal(bind(user_id, "subject-x", { provider_id: "nope" }))).toBe(
      "provider_unavailable",
    );
    expect(await bindingsOf(user_id)).toEqual([]);
  });

  test("a non-OIDC provider is unavailable", async () => {
    const user_id = await seedUser("refuse-api-key");

    expect(await refusal(bind(user_id, "subject-x", { provider_id: "api-key" }))).toBe(
      "provider_unavailable",
    );
    expect(await bindingsOf(user_id)).toEqual([]);
  });

  test("a provider cannot bind identities in a tenant it does not serve", async () => {
    const user_id = await seedUser("refuse-tenant", { tenant_id: foreignTenantId });

    expect(await refusal(bind(user_id, "subject-x", { tenant_id: foreignTenantId }))).toBe(
      "provider_tenant_mismatch",
    );
    const rows = await tdb.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, user_id));
    expect(rows).toEqual([]);
  });

  test("a user of another tenant is unavailable", async () => {
    const user_id = await seedUser("refuse-foreign-user", { tenant_id: foreignTenantId });

    expect(await refusal(bind(user_id, "subject-x"))).toBe("user_unavailable");
  });

  test("a disabled user is unavailable", async () => {
    const user_id = await seedUser("refuse-disabled", { status: "disabled" });

    expect(await refusal(bind(user_id, "subject-x"))).toBe("user_unavailable");
    expect(await bindingsOf(user_id)).toEqual([]);
  });

  test("a deleted user is unavailable", async () => {
    const user_id = await seedUser("refuse-deleted", {
      deleted_at: new Date("2023-01-01T00:00:00.000Z"),
    });

    expect(await refusal(bind(user_id, "subject-x"))).toBe("user_unavailable");
    expect(await bindingsOf(user_id)).toEqual([]);
  });

  test("a subject bound to another user cannot be taken over", async () => {
    const owner = await seedUser("refuse-owner");
    const owned = await bind(owner, "subject-owned");
    const attacker = await seedUser("refuse-attacker");

    expect(await refusal(bind(attacker, "subject-owned"))).toBe("identity_binding_conflict");
    expect(await bindingsOf(attacker)).toEqual([]);
    const [kept] = await bindingsOf(owner);
    expect(kept?.id).toBe(owned.binding.id);
    expect(kept?.subject).toBe("subject-owned");
  });

  test("a user already bound under another subject is not rebound", async () => {
    const user_id = await seedUser("refuse-rebind");
    await bind(user_id, "subject-original");

    expect(await refusal(bind(user_id, "subject-replacement"))).toBe("identity_binding_conflict");
    expect((await bindingsOf(user_id)).map((row) => row.subject)).toEqual(["subject-original"]);
  });

  test("a binding pinned to another issuer conflicts", async () => {
    const user_id = await seedUser("refuse-issuer");
    await seedBinding({
      user_id,
      subject: "subject-issuer",
      issuer_url: "https://elsewhere.example.test",
    });

    expect(await refusal(bind(user_id, "subject-issuer"))).toBe("identity_binding_conflict");
  });

  test("a binding pinned to the issuer without the provider's product conflicts", async () => {
    const user_id = await seedUser("refuse-product-missing");
    await seedBinding({
      user_id,
      provider_id: "app-sso",
      subject: "subject-product-missing",
      issuer_url: APP_ISSUER,
      product_id: null,
    });

    expect(
      await refusal(bind(user_id, "subject-product-missing", { provider_id: "app-sso" })),
    ).toBe("identity_binding_conflict");
  });

  test("an unpinned binding of another product conflicts", async () => {
    const user_id = await seedUser("refuse-product-other");
    await seedBinding({
      user_id,
      provider_id: "app-sso",
      subject: "subject-product-other",
      issuer_url: null,
      product_id: "app-two",
    });

    expect(await refusal(bind(user_id, "subject-product-other", { provider_id: "app-sso" }))).toBe(
      "identity_binding_conflict",
    );
  });
});

describe("validating binding input", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["a subject with surrounding whitespace", { subject: " padded" }],
    ["a subject with a control character", { subject: "line\nbreak" }],
    ["a subject with DEL", { subject: "del\u007f" }],
    ["an empty subject", { subject: "" }],
    ["a subject over 1024 characters", { subject: "s".repeat(1025) }],
    ["a provider id starting with an uppercase letter", { provider_id: "Corp-sso" }],
    ["a provider id ending in uppercase letters", { provider_id: "corp-SSO" }],
    ["a non-uuid tenant", { tenant_id: "home" }],
    ["an unknown actor kind", { actor_kind: "portal_token" }],
    ["an unknown request source", { request_source: "carrier-pigeon" }],
    ["an extra key", { email: "takeover@example.test" }],
  ];

  for (const [label, overrides] of invalid) {
    test(`${label} is rejected before any lookup`, async () => {
      const user_id = await seedUser(`invalid-${label.replaceAll(" ", "-")}`);

      const error = await bind(user_id, "subject-valid", overrides).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ZodError);
      expect(await bindingsOf(user_id)).toEqual([]);
    });
  }

  test("a 1024-character subject with inner spaces is accepted", async () => {
    const user_id = await seedUser("valid-long");
    const subject = `a ${"s".repeat(1022)}`;

    const result = await bind(user_id, subject);

    expect(result.binding.subject).toBe(subject);
  });
});
