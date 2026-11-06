import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import { apiKeys, chatIdentities, users } from "../../db/schema/index.ts";
import { builtinRoleId, createRole } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const hex = createDeterministicHexFactory(0xc4a57_5eed);

let ctx: HttpTestServer;
let noopApiKey: string;
let memberApiKey: string;
let secondTenantApiKey: string;

async function mintApiKey(
  db: HttpTestServer["db"],
  tenantId: string,
  userId: string,
): Promise<string> {
  const rand = hex(24).slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  const prefix = plaintext.slice(0, 12);
  const hash = createHash("sha256").update(plaintext).digest("hex");
  await db.insert(apiKeys).values({
    tenant_id: tenantId,
    user_id: userId,
    prefix,
    token_sha256: hash,
    scopes: ["*"],
  });
  return plaintext;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-spaces");

  await ctx.db.insert(chatIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    platform: "google_chat",
    workspace_id: "spaces/PENDING1",
    platform_user_id: "users/caller-1",
  });

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      action: AuditAction.CHAT_MESSAGE_DENIED,
      resource_type: "chat_workspace",
      resource_id: null,
      result: "denied",
      reason: "workspace_not_installed",
      metadata: {
        platform: "google_chat",
        workspace_id_native: "spaces/PENDING1",
        event_key: null,
        kind: "mention",
        sender_platform_user_id: "users/caller-1",
        space_display_name: "Pending One",
      },
    },
    ctx.db,
  );

  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-chat-spaces", "no permissions");
  const [noopUser] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "noop-chat-spaces@test.local",
      role_id: noopRole.id,
    })
    .returning();
  if (!noopUser) throw new Error("seed noop user failed");
  noopApiKey = await mintApiKey(ctx.db, ctx.tenantId, noopUser.id);

  const [memberUser] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-chat-spaces@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!memberUser) throw new Error("seed member user failed");
  memberApiKey = await mintApiKey(ctx.db, ctx.tenantId, memberUser.id);

  const tenant2 = await seedTenant(ctx.db, { slug: "t-chat-spaces-b", display_name: "Tenant B" });
  const [admin2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant2.id,
      email: "admin-chat-spaces-b@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!admin2) throw new Error("seed admin B failed");
  secondTenantApiKey = await mintApiKey(ctx.db, tenant2.id, admin2.id);
});

afterAll(async () => {
  // allow-wall-clock: real ms required to flush postgres write queue.
  await new Promise((r) => setTimeout(r, 250));
  // allow-wall-clock: wall-clock cap on cleanup to avoid Bun's 5s afterAll timeout.
  await Promise.race([ctx.cleanup(), new Promise<void>((r) => setTimeout(r, 4000))]);
}, 10_000);

describe("GET /v1/chat/spaces/pending", () => {
  test("200 — admin caller sees their pending google_chat space", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/spaces/pending`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        platform: string;
        workspace_id: string;
        display_name: string | null;
        installer_platform_user_id: string;
      }>;
    };
    expect(body.items).toContainEqual({
      platform: "google_chat",
      workspace_id: "spaces/PENDING1",
      display_name: "Pending One",
      installer_platform_user_id: "users/caller-1",
    });
  });

  test("200 — non-admin member (holds chat_workspace:read) passes the RBAC gate", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/spaces/pending`, {
      headers: { authorization: `Bearer ${memberApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  test("403 — non-admin caller without chat_workspace:read is rejected", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/spaces/pending`, {
      headers: { authorization: `Bearer ${noopApiKey}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  test("401 — missing bearer is rejected by auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/spaces/pending`);
    expect(res.status).toBe(401);
  });

  test("empty items — caller with no chat_identity sees []", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/spaces/pending`, {
      headers: { authorization: `Bearer ${secondTenantApiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
