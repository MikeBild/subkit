// HTTP integration tests for `GET /v1/chat/spaces/pending`.
//
// The route is a thin wrapper over `listPendingSpacesForPrincipal`
// (apps/engine/src/chat/pending-spaces.ts) — see that module's
// doc-block for the isolation model. These tests seed the SYSTEM
// deny-pool audit row + the caller's own `chat_identities` row
// directly against the test db (mirrors connector-discovery.test.ts's
// harness usage) and assert the HTTP contract + RBAC gate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import { apiKeys, chatIdentities, tenants, users } from "../../db/schema/index.ts";
import { createRole } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const hex = createDeterministicHexFactory(0xc4a57_5eed);

let ctx: HttpTestServer;
// Non-admin caller in the SAME tenant, bound to a no-permission custom
// role — proves the `chat_workspace:read` gate actually denies.
let noopApiKey: string;
// Built-in `member` role caller (holds `chat_workspace:read` per
// rbac/seed.ts) — proves a non-admin WITH the permission still gets 200.
let memberApiKey: string;
// Second tenant's admin — no `chat_identities` row at all, so the
// caller has no usable (global-id) identity and must see `items: []`.
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

  // The caller's own verified identity — the ONLY tenant-safe
  // attribution key the pending-spaces query accepts.
  await ctx.db.insert(chatIdentities).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    platform: "google_chat",
    workspace_id: "spaces/PENDING1",
    platform_user_id: "users/caller-1",
  });

  // SYSTEM deny-pool row the chat.event worker would have written when
  // the caller added the app to a named space it hasn't installed yet.
  // Bound to the per-suite test db (2nd arg) — the default `audit()`
  // executor is the shared production db client, which this suite's
  // disposable database is not.
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

  // Non-admin, no-permission custom role — the 403 negative case.
  const noopRole = await createRole(ctx.db, ctx.tenantId, "noop-chat-spaces", "no permissions");
  const [noopUser] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "noop-chat-spaces@test.local",
      role: "member",
      role_id: noopRole.id,
    })
    .returning();
  if (!noopUser) throw new Error("seed noop user failed");
  noopApiKey = await mintApiKey(ctx.db, ctx.tenantId, noopUser.id);

  // Built-in `member` role (no custom role_id) — the 200-with-non-admin
  // positive case. rbac/seed.ts grants `chat_workspace:read` to member.
  const [memberUser] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-chat-spaces@test.local",
      role: "member",
    })
    .returning();
  if (!memberUser) throw new Error("seed member user failed");
  memberApiKey = await mintApiKey(ctx.db, ctx.tenantId, memberUser.id);

  // Second tenant, own admin, deliberately NO chat_identities row.
  const [tenant2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-chat-spaces-b", display_name: "Tenant B" })
    .returning();
  if (!tenant2) throw new Error("seed tenant B failed");
  const [admin2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant2.id,
      email: "admin-chat-spaces-b@test.local",
      role: "admin",
    })
    .returning();
  if (!admin2) throw new Error("seed admin B failed");
  secondTenantApiKey = await mintApiKey(ctx.db, tenant2.id, admin2.id);
});

afterAll(async () => {
  // Drain fire-and-forget `api_key.used` audit inserts before the
  // per-suite database tears down (mirrors connector-discovery.test.ts).
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
    // This member user never DM'd the app, so they have no chat_identity
    // of their own and legitimately see [] — pending spaces are scoped to
    // the CALLER's own verified identity, not shared tenant-wide. The
    // assertion here is the RBAC outcome (200, not 403); the admin test
    // above (same permission, but WITH an owned identity) proves the
    // positive data path.
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
