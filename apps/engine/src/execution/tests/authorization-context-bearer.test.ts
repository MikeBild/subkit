import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { productSubjectDigest } from "../../auth/identity-link.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { productIdentityTombstones, userIdentities, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  authorizationContextFromPrincipal,
  rehydrateExecutionPrincipal,
} from "../authorization-context.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

const ISSUED = new Date("2026-10-15T10:00:00.000Z");
const nextUuid = createDeterministicUuidFactory(0xbea7);
let ctx: EngineTestCtx;

async function bearerPrincipal(): Promise<ResolvedPrincipal> {
  const subject = nextUuid();
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `tekit-supabase:${subject}@invalid`,
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  const [identity] = await ctx.testDb.db
    .insert(userIdentities)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      provider_id: "tekit-supabase",
      issuer_url: "https://auth.example.test/auth/v1",
      product_id: "tekit",
      subject,
      email: `tekit-supabase:${subject}@invalid`,
    })
    .returning({ id: userIdentities.id });
  if (!identity) throw new Error("identity fixture missing");
  return {
    provider: "tekit-supabase",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    product_id: "tekit",
    roles: ["member"],
    subject,
    auth_source: {
      kind: "external_bearer",
      provider_id: "tekit-supabase",
      identity_id: identity.id,
      issued_at: ISSUED.toISOString(),
      expires_at: new Date(ISSUED.getTime() + 3_600_000).toISOString(),
    },
  };
}

function persisted(principal: ResolvedPrincipal) {
  return {
    caller: callerFromPrincipal(principal, ctx.tenantId, "tekit", "user"),
    authorization: authorizationContextFromPrincipal(principal),
  };
}

beforeAll(async () => {
  ctx = await createEngineCtx("authorization-bearer");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("rehydrating an external bearer caller", () => {
  test("a queued run resumes after the access token expired while the identity is live", async () => {
    const principal = await bearerPrincipal();
    const { caller, authorization } = persisted(principal);
    const later = new Date(ISSUED.getTime() + 5 * 3_600_000);
    const restored = await rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization, later);
    expect(restored).toMatchObject({
      id: principal.id,
      product_id: "tekit",
      subject: principal.subject,
      auth_source: { kind: "external_bearer" },
    });
    expect(restored?.oauth_client_id).toBeUndefined();
    expect(restored?.scopes).toBeUndefined();
  });

  test("it is refused once the subject was erased", async () => {
    const principal = await bearerPrincipal();
    const { caller, authorization } = persisted(principal);
    await ctx.testDb.db.insert(productIdentityTombstones).values({
      tenant_id: ctx.tenantId,
      provider_id: "tekit-supabase",
      issuer_url: "https://auth.example.test/auth/v1",
      subject_sha256: productSubjectDigest(principal.subject ?? ""),
      erased_at: new Date(ISSUED.getTime() + 60_000),
    });
    await expect(
      rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization),
    ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  });

  test("it is refused once the user was disabled", async () => {
    const principal = await bearerPrincipal();
    const { caller, authorization } = persisted(principal);
    await ctx.testDb.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
    await expect(
      rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization),
    ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  });

  test("it is refused once the identity binding was removed", async () => {
    const principal = await bearerPrincipal();
    const { caller, authorization } = persisted(principal);
    await ctx.testDb.db
      .delete(userIdentities)
      .where(
        and(eq(userIdentities.tenant_id, ctx.tenantId), eq(userIdentities.user_id, principal.id)),
      );
    await expect(
      rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization),
    ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  });

  test("a binding of another product or subject is refused", async () => {
    const principal = await bearerPrincipal();
    const { caller, authorization } = persisted(principal);
    await expect(
      rehydrateExecutionPrincipal(ctx.testDb.db, { ...caller, subject: nextUuid() }, authorization),
    ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  });
});
