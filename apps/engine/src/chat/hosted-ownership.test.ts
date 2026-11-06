import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  IdentityLinkConflictError,
  resolveProductBearerIdentity,
  resolveProviderIdentity,
} from "../auth/identity-link.ts";
import { getConfig, setConfigKey } from "../config/loader.ts";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import {
  chatIdentities,
  chatWorkspaces,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import type { ChatAdapter } from "./adapter.ts";
import { handleChatEvent } from "./dispatcher.ts";
import { ensureDmAutoRegistration } from "./dm-autoregister.ts";
import {
  assertChatWorkspaceOwnershipAvailable,
  HostedChatOwnershipRequired,
} from "./hosted-ownership.ts";
import type { ChatEvent } from "./types.ts";

let ctx: HttpTestServer;
const pid = "users/hosted-owner";
const workspaceId = "spaces/HOSTED_EXISTING";
beforeAll(async () => {
  ctx = await createHttpTestServer("chat-hosted-ownership", { operator: false, hosted: true });
  for (const name of [
    "peer_per_minute",
    "principal_per_minute",
    "tenant_per_minute",
    "global_per_minute",
  ])
    await setConfigKey(`server.hosted_rate_limit.${name}`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  const [tenant] = await ctx.db
    .select({ owner_identity_id: tenants.owner_identity_id })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId));
  if (!tenant?.owner_identity_id) throw new Error("missing hosted owner identity");
  await ctx.db
    .update(users)
    .set({ auth_identity_id: tenant.owner_identity_id })
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, ctx.userId)));
  const secret = encryptSecret("not-used");
  await ctx.db.insert(chatWorkspaces).values({
    tenant_id: ctx.tenantId,
    platform: "google_chat",
    workspace_id: workspaceId,
    bot_ciphertext: secret.ciphertext,
    bot_iv: secret.iv,
    bot_auth_tag: secret.auth_tag,
  });
  await ctx.db.insert(chatIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    platform: "google_chat",
    workspace_id: workspaceId,
    platform_user_id: pid,
  });
});
afterAll(async () => {
  await ctx?.cleanup();
});
function event(): ChatEvent {
  return {
    platform: "google_chat",
    workspace_id: workspaceId,
    channel_id: workspaceId,
    user_id: pid,
    kind: "mention",
    text: "hello",
    is_direct_message: true,
    raw: {},
  };
}
function post(path: string, body: unknown) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("hosted workspace installation and manual identity claims are locked despite hosted service flags being off", async () => {
  expect(getConfig().auth.hosted.enabled).toBe(false);
  for (const platform of ["slack", "google_chat"]) {
    const response = await post("/v1/chat/workspaces", {
      platform,
      workspace_id: `claimed-${platform}`,
      installer_platform_user_id: pid,
      ...(platform === "slack" ? { bot_token: "unverified-token" } : {}),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "chat_ownership_required" });
  }
  const response = await post("/v1/chat/identities", {
    platform: "google_chat",
    workspace_id: workspaceId,
    platform_user_id: "users/unproven",
    user_id: ctx.userId,
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "chat_ownership_required" });
  expect(
    await ctx.db.select().from(chatWorkspaces).where(eq(chatWorkspaces.tenant_id, ctx.tenantId)),
  ).toHaveLength(1);
  expect(
    await ctx.db.select().from(chatIdentities).where(eq(chatIdentities.tenant_id, ctx.tenantId)),
  ).toHaveLength(1);
});
test("a historical chat identity cannot bootstrap another hosted DM space", async () => {
  const result = await ensureDmAutoRegistration(ctx.db, {
    ...event(),
    workspace_id: "spaces/UNPROVEN_DM",
    channel_id: "spaces/UNPROVEN_DM",
  });
  expect(result).toEqual({ denied: "hosted_ownership_proof_required" });
  expect(
    await ctx.db.select().from(chatWorkspaces).where(eq(chatWorkspaces.tenant_id, ctx.tenantId)),
  ).toHaveLength(1);
});
test("historical installed hosted workspaces cannot dispatch or send before ownership proof", async () => {
  let calls = 0;
  const adapter: ChatAdapter = {
    platform: "google_chat",
    async verify() {
      return null;
    },
    async receive() {
      return event();
    },
    async send() {
      calls++;
      return { platform_message_id: "unexpected" };
    },
    async update() {
      calls++;
    },
    async sendApproval() {
      calls++;
      return { platform_message_id: "unexpected" };
    },
  };
  const result = await handleChatEvent({ db: ctx.db, adapter }, event());
  expect(result).toMatchObject({ status: "rejected" });
  expect(result.reply_text).toContain("ownership");
  expect(calls).toBe(0);
});
test("tenant-local email linking cannot bypass the hosted global identity membership path", async () => {
  const [owner] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, ctx.userId)));
  if (!owner) throw new Error("missing owner");
  await expect(
    resolveProviderIdentity(ctx.db, {
      tenantId: ctx.tenantId,
      providerId: "untrusted-tenant-local",
      issuerUrl: "https://other-identity.example.test",
      subject: "other-subject",
      email: owner.email,
      linkByEmail: true,
      allowCreate: true,
    }),
  ).rejects.toBeInstanceOf(IdentityLinkConflictError);
  expect(
    await ctx.db.select().from(userIdentities).where(eq(userIdentities.tenant_id, ctx.tenantId)),
  ).toHaveLength(0);
});
test("self-hosted tenants retain their existing chat installation policy", async () => {
  const selfhost = await seedTenant(ctx.db, {
    slug: "hosted-chat-selfhost-control",
    display_name: "Selfhost",
  });
  await expect(assertChatWorkspaceOwnershipAvailable(ctx.db, selfhost.id)).resolves.toBeUndefined();
  await expect(assertChatWorkspaceOwnershipAvailable(ctx.db, ctx.tenantId)).rejects.toBeInstanceOf(
    HostedChatOwnershipRequired,
  );
});

test("product bearer JIT provisioning cannot create a tenant-local hosted identity", async () => {
  await expect(
    resolveProductBearerIdentity(ctx.db, {
      tenantId: ctx.tenantId,
      providerId: "product-provider",
      issuerUrl: "https://product-identity.example.test",
      productId: "external-product",
      subject: "product-user",
      issuedAt: new Date(FROZEN_NOW),
      now: new Date(FROZEN_NOW),
    }),
  ).rejects.toBeInstanceOf(IdentityLinkConflictError);
  expect(
    await ctx.db.select().from(userIdentities).where(eq(userIdentities.tenant_id, ctx.tenantId)),
  ).toHaveLength(0);
});
