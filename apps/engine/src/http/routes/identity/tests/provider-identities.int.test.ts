import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  IdentityLinkConflictError,
  resolveProviderIdentity,
  SignupDisabledError,
} from "../../../../auth/index.ts";
import { auditLog, tenants, userIdentities, users } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/index.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import {
  createHttpTestServer,
  type HttpTestServer,
  loadAuthProvidersForTest,
} from "../../../tests/setup.ts";

let ctx: HttpTestServer;
let tenantSlug = "";
let owner = "";
let anotherOwner = "";
let memberKey = "";
const issuer = "https://identity.example";

async function configure(
  issuer_url = issuer,
  product_id: string | undefined = "product-example",
  slug = tenantSlug,
) {
  await loadAuthProvidersForTest(
    [
      {
        protocol: "oidc",
        id: "product-login",
        label: "Product",
        issuer_url,
        client_id: "public-client",
        tenant_slug: slug,
        scopes: "openid",
        ...(product_id ? { product_id } : {}),
      },
    ],
    ctx.testDb.url,
    { enableSignup: true },
  );
}

beforeAll(async () => {
  ctx = await createHttpTestServer("provider-identities");
  const [tenant] = await ctx.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (!tenant) throw new Error("tenant missing");
  tenantSlug = tenant.slug;
  const role = await builtinRoleId(ctx.db, "member");
  const rows = await ctx.db
    .insert(users)
    .values([
      { tenant_id: ctx.tenantId, email: "owner@example.test", role_id: role },
      { tenant_id: ctx.tenantId, email: "another@example.test", role_id: role },
    ])
    .returning();
  const first = rows[0];
  const second = rows[1];
  if (!first || !second) throw new Error("owners missing");
  owner = first.id;
  anotherOwner = second.id;
  memberKey = (
    await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: ctx.tenantId,
        owner_kind: "user",
        owner_id: owner,
        actor_id: ctx.userId,
      },
      ctx.db,
    )
  ).plaintext;
  await configure();
}, 30_000);
afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

function bind(
  user_id: string,
  subject: string,
  key = ctx.apiKey,
  extra: Record<string, unknown> = {},
) {
  return fetch(`${ctx.baseUrl}/v1/identity/users/${user_id}/provider-identities`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "product-login", subject, ...extra }),
  });
}

test("operator creates an exact configured binding once without granting roles", async () => {
  const first = await bind(owner, "owner-subject");
  expect(first.status).toBe(201);
  const body = await first.json();
  expect(body).toMatchObject({
    user_id: owner,
    issuer_url: issuer,
    product_id: "product-example",
    subject: "owner-subject",
    replayed: false,
  });
  const again = await bind(owner, "owner-subject");
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: body.id, replayed: true });
  const [user] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, owner)));
  expect(user?.role_id).toBe(await builtinRoleId(ctx.db, "member"));
  const audits = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, body.id)));
  expect(audits).toHaveLength(1);
});

test("subject and owner conflicts cannot reassign the original binding", async () => {
  expect((await bind(anotherOwner, "owner-subject")).status).toBe(409);
  expect((await bind(owner, "different-subject")).status).toBe(409);
});

test("issuer and product changes cannot reuse a previously pinned identity", async () => {
  try {
    await configure("https://changed.example");
    expect((await bind(owner, "owner-subject")).status).toBe(409);
    await configure(issuer, "other-product");
    expect((await bind(owner, "owner-subject")).status).toBe(409);
    await expect(
      resolveProviderIdentity(ctx.db, {
        tenantId: ctx.tenantId,
        providerId: "product-login",
        subject: "owner-subject",
        issuerUrl: "https://changed.example",
        productId: "product-example",
        email: "owner@example.test",
        linkByEmail: false,
        allowCreate: false,
      }),
    ).rejects.toBeInstanceOf(IdentityLinkConflictError);
  } finally {
    await configure();
  }
});

test("operator permissions and provider tenant boundaries are enforced", async () => {
  expect((await bind(owner, "owner-subject", memberKey)).status).toBe(403);
  expect((await bind(owner, "owner-subject", "invalid-key")).status).toBe(401);
  expect((await bind("e12aa99a-7ab6-43be-8dfe-a918ee786122", "unknown")).status).toBe(404);
  expect(
    (await bind(owner, "owner-subject", ctx.apiKey, { issuer_url: "https://untrusted.example" }))
      .status,
  ).toBe(400);
  try {
    await configure(issuer, "product-example", "other-tenant");
    expect((await bind(owner, "owner-subject")).status).toBe(403);
  } finally {
    await configure();
  }
});

test("product identities never auto-link by email or create a member", async () => {
  await expect(
    resolveProviderIdentity(ctx.db, {
      tenantId: ctx.tenantId,
      providerId: "product-login",
      subject: "new-subject",
      issuerUrl: issuer,
      productId: "product-example",
      email: "owner@example.test",
      linkByEmail: true,
      allowCreate: true,
    }),
  ).rejects.toBeInstanceOf(SignupDisabledError);
});

test("email-link opt out refuses the unique-email collision instead of inheriting its account", async () => {
  await expect(
    resolveProviderIdentity(ctx.db, {
      tenantId: ctx.tenantId,
      providerId: "unbound-login",
      subject: "unbound-new-subject",
      issuerUrl: issuer,
      email: "owner@example.test",
      linkByEmail: false,
      allowCreate: true,
    }),
  ).rejects.toBeInstanceOf(IdentityLinkConflictError);
  const rows = await ctx.db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, ctx.tenantId),
        eq(userIdentities.provider_id, "unbound-login"),
      ),
    );
  expect(rows).toHaveLength(0);
});

test("legacy product identity needs explicit operator pinning before login", async () => {
  await ctx.db.insert(userIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: anotherOwner,
    provider_id: "product-login",
    subject: "legacy-subject",
    email: "another@example.test",
  });
  const options = {
    tenantId: ctx.tenantId,
    providerId: "product-login",
    subject: "legacy-subject",
    issuerUrl: issuer,
    productId: "product-example",
    email: "another@example.test",
    linkByEmail: false,
    allowCreate: false,
  };
  await expect(resolveProviderIdentity(ctx.db, options)).rejects.toBeInstanceOf(
    IdentityLinkConflictError,
  );
  expect((await bind(anotherOwner, "legacy-subject")).status).toBe(201);
  expect((await resolveProviderIdentity(ctx.db, options)).user.id).toBe(anotherOwner);
});

test("concurrent operator retries create one audited binding", async () => {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "concurrent@example.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("owner missing");
  const responses = await Promise.all([
    bind(user.id, "concurrent-subject"),
    bind(user.id, "concurrent-subject"),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  const rows = await ctx.db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, ctx.tenantId),
        eq(userIdentities.subject, "concurrent-subject"),
      ),
    );
  expect(rows).toHaveLength(1);
  const records = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.resource_id, rows[0]?.id ?? ""),
        eq(auditLog.action, "user.identity_linked"),
      ),
    );
  expect(records).toHaveLength(1);
});

test("unbound email linking stays compatible and pins verified issuer once", async () => {
  const result = await resolveProviderIdentity(ctx.db, {
    tenantId: ctx.tenantId,
    providerId: "unbound-compatible",
    subject: "compatible-subject",
    issuerUrl: issuer,
    email: "owner@example.test",
    linkByEmail: true,
    allowCreate: false,
  });
  expect(result.user.id).toBe(owner);
  expect(result.createdUser).toBe(false);
  const [row] = await ctx.db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, ctx.tenantId),
        eq(userIdentities.subject, "compatible-subject"),
      ),
    );
  expect(row?.issuer_url).toBe(issuer);
  await expect(
    resolveProviderIdentity(ctx.db, {
      tenantId: ctx.tenantId,
      providerId: "unbound-compatible",
      subject: "compatible-subject",
      issuerUrl: "https://changed.example",
      email: "changed@example.test",
      linkByEmail: true,
      allowCreate: true,
    }),
  ).rejects.toBeInstanceOf(IdentityLinkConflictError);
  const [unchanged] = await ctx.db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, ctx.tenantId),
        eq(userIdentities.subject, "compatible-subject"),
      ),
    );
  expect(unchanged?.email).toBe("owner@example.test");
});

test("disabled users cannot acquire a provider binding", async () => {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "disabled@example.test",
      status: "disabled",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("owner missing");
  expect((await bind(user.id, "disabled-subject")).status).toBe(404);
  expect(
    await ctx.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.user_id, user.id))),
  ).toHaveLength(0);
});

test("unbound legacy identity pins its configured issuer after verified login", async () => {
  await ctx.db.insert(userIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: owner,
    provider_id: "unbound-existing",
    subject: "existing-subject",
    email: "owner@example.test",
  });
  const options = {
    tenantId: ctx.tenantId,
    providerId: "unbound-existing",
    subject: "existing-subject",
    issuerUrl: issuer,
    email: "owner@example.test",
    linkByEmail: false,
    allowCreate: false,
  };
  expect((await resolveProviderIdentity(ctx.db, options)).user.id).toBe(owner);
  const [row] = await ctx.db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, ctx.tenantId),
        eq(userIdentities.provider_id, "unbound-existing"),
      ),
    );
  expect(row?.issuer_url).toBe(issuer);
  expect(row?.product_id).toBeNull();
  await expect(
    resolveProviderIdentity(ctx.db, { ...options, issuerUrl: "https://changed.example" }),
  ).rejects.toBeInstanceOf(IdentityLinkConflictError);
});
