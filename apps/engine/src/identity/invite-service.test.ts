import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, tenants, userInvites, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  createInvite,
  createUser,
  deactivateUser,
  redeemInvite,
  revokeInvite,
} from "./provisioning.ts";
import { createSystemAccount, listApiKeys } from "./service.ts";

let testDb: TestDb;
let tenantId = "";
let otherTenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("invite-service");

  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "inv-tenant", display_name: "Invite Tenant" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;

  const [other] = await testDb.db
    .insert(tenants)
    .values({ slug: "inv-other", display_name: "Other Tenant" })
    .returning();
  if (!other) throw new Error("seed other tenant failed");
  otherTenantId = other.id;
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

async function seedInvitedUser(email: string) {
  return createUser(
    { tenant_id: tenantId, email, role: "member", status: "invited", actor_id: null },
    testDb.db,
  );
}

describe("createInvite", () => {
  test("explicit system-account actors are preserved while untyped callers stay unknown", async () => {
    const user = await seedInvitedUser("inv-typed-actor@test.local");
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "invite-actor", actor_id: null },
      testDb.db,
    );
    const created = await createInvite(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        user_id: user.id,
        actor_kind: "system_account",
        actor_id: actor.id,
      },
      testDb.db,
    );
    const [createdAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.invited"), eq(auditLog.resource_id, created.view.id)));
    expect(createdAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });

    const revoked = await revokeInvite(
      {
        tenant_id: tenantId,
        invite_id: created.view.id,
        actor_kind: "system_account",
        actor_id: actor.id,
      },
      testDb.db,
    );
    expect(revoked).not.toBeNull();
    const [revokedAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user_invite.revoked"), eq(auditLog.resource_id, created.view.id)),
      );
    expect(revokedAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });

    const legacy = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: actor.id },
      testDb.db,
    );
    const [legacyAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.invited"), eq(auditLog.resource_id, legacy.view.id)));
    expect(legacyAudit).toEqual({ actor_type: "unknown", actor_id: null });

    const missingId = await createInvite(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        user_id: user.id,
        actor_kind: "system_account",
        actor_id: null,
      },
      testDb.db,
    );
    const [missingIdAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.invited"), eq(auditLog.resource_id, missingId.view.id)));
    expect(missingIdAudit).toEqual({ actor_type: "unknown", actor_id: null });
  });

  test("mints an invite + USER_INVITED audit row; records the granted scopes", async () => {
    const user = await seedInvitedUser("inv-create@test.local");
    const { view, plaintext } = await createInvite(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        user_id: user.id,
        scopes: ["workflow:read", "workflow:run"],
        actor_id: null,
      },
      testDb.db,
    );
    expect(plaintext).toMatch(/^wf_invite_/);
    expect(view.scopes).toEqual(["workflow:read", "workflow:run"]);
    expect(view.redeemed_at).toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.invited"), eq(auditLog.resource_id, view.id)));
    expect(audit.length).toBe(1);
  });
});

describe("redeemInvite", () => {
  test("happy path mints a user-owned key with the invite's scopes + activates the user", async () => {
    const user = await seedInvitedUser("inv-happy@test.local");
    const { plaintext } = await createInvite(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        user_id: user.id,
        scopes: ["workflow:read"],
        actor_id: null,
      },
      testDb.db,
    );

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.user_id).toBe(user.id);
    expect(outcome.api_key.plaintext).toMatch(/^wf_live_/);
    expect(outcome.api_key.view.user_id).toBe(user.id);
    expect(outcome.api_key.view.scopes).toEqual(["workflow:read"]);

    const keys = await listApiKeys(tenantId, testDb.db);
    expect(keys.find((k) => k.id === outcome.api_key.view.id)?.user_id).toBe(user.id);

    const [refreshed] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(refreshed?.status).toBe("active");

    const redeemed = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user_invite.redeemed"));
    expect(redeemed.find((r) => r.resource_id !== null)).toBeDefined();
  });

  test("second redeem of the same token returns invite_already_redeemed", async () => {
    const user = await seedInvitedUser("inv-double@test.local");
    const { plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    const first = await redeemInvite({ token: plaintext }, testDb.db);
    expect(first.ok).toBe(true);

    const second = await redeemInvite({ token: plaintext }, testDb.db);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected failure");
    expect(second.code).toBe("invite_already_redeemed");

    const keys = await listApiKeys(tenantId, testDb.db);
    expect(keys.filter((k) => k.user_id === user.id).length).toBe(1);
  });

  test("expired invite returns invite_expired", async () => {
    const user = await seedInvitedUser("inv-expired@test.local");
    const { view, plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    await testDb.db
      .update(userInvites)
      .set({ expires_at: new Date(getTestNow() - 1_000) })
      .where(eq(userInvites.id, view.id));

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_expired");
  });

  test("revoked invite returns invite_revoked", async () => {
    const user = await seedInvitedUser("inv-revoked@test.local");
    const { view, plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    const revoked = await revokeInvite(
      { tenant_id: tenantId, invite_id: view.id, actor_id: null },
      testDb.db,
    );
    expect(revoked).not.toBeNull();

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_revoked");
  });

  test("garbage / malformed token returns invite_invalid", async () => {
    const outcome = await redeemInvite({ token: "not-a-real-token" }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_invalid");
  });
});

describe("revokeInvite — tenant isolation", () => {
  test("wrong tenant cannot revoke another tenant's invite", async () => {
    const user = await seedInvitedUser("inv-iso@test.local");
    const { view } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    const cross = await revokeInvite(
      { tenant_id: otherTenantId, invite_id: view.id, actor_id: null },
      testDb.db,
    );
    expect(cross).toBeNull();
  });
});

describe("deactivateUser", () => {
  test("deactivation cascade preserves a system-account actor", async () => {
    const user = await seedInvitedUser("inv-deactivate-typed-actor@test.local");
    const actor = await createSystemAccount(
      { tenant_id: tenantId, name: "deactivate-actor", actor_id: null },
      testDb.db,
    );
    await deactivateUser(
      {
        tenant_id: tenantId,
        user_id: user.id,
        actor_kind: "system_account",
        actor_id: actor.id,
      },
      testDb.db,
    );
    const [deletedAudit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.deleted"), eq(auditLog.resource_id, user.id)));
    expect(deletedAudit).toEqual({ actor_type: "system_account", actor_id: actor.id });
  });

  test("soft-deletes the user, sets status=disabled, and revokes their keys", async () => {
    const user = await seedInvitedUser("inv-deact@test.local");
    const { plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    const redeemed = await redeemInvite({ token: plaintext }, testDb.db);
    if (!redeemed.ok) throw new Error("expected ok");

    const result = await deactivateUser(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe("disabled");
    expect(result?.deleted_at).not.toBeNull();

    const keys = await listApiKeys(tenantId, testDb.db);
    const minted = keys.find((k) => k.id === redeemed.api_key.view.id);
    expect(minted?.revoked_at).not.toBeNull();

    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.deleted"), eq(auditLog.resource_id, user.id)));
    expect(audit.length).toBe(1);
  });
});

describe("redeemInvite — concurrent serialization (H1)", () => {
  test("two concurrent redeems: exactly one mints a key, the other returns invite_already_redeemed", async () => {
    const user = await seedInvitedUser("inv-concurrent@test.local");
    const { view: inviteView, plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    const [result1, result2] = await Promise.all([
      redeemInvite({ token: plaintext }, testDb.db),
      redeemInvite({ token: plaintext }, testDb.db),
    ]);

    const outcomes = [result1, result2];
    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o) => !o.ok);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (!failure || failure.ok) throw new Error("expected a failure outcome");
    expect(failure.code).toBe("invite_already_redeemed");

    const mintedKeys = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(mintedKeys.length).toBe(1);

    const redeemAudit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user_invite.redeemed"), eq(auditLog.resource_id, inviteView.id)),
      );
    expect(redeemAudit.length).toBe(1);
  });
});

describe("revokeInvite — INVITE_REVOKED audit row (H2)", () => {
  test("revokeInvite writes an INVITE_REVOKED audit row carrying tenant_id and actor_id", async () => {
    const user = await seedInvitedUser("inv-revoke-audit@test.local");
    const { view } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    const actorId = user.id;
    const revokedView = await revokeInvite(
      { tenant_id: tenantId, invite_id: view.id, actor_id: actorId },
      testDb.db,
    );
    expect(revokedView).not.toBeNull();

    const auditRows = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "user_invite.revoked"), eq(auditLog.resource_id, view.id)));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]).toEqual({ actor_type: "unknown", actor_id: null });
  });
});

describe("deactivateUser — severs pending invite (H3)", () => {
  test("deactivateUser stamps revoked_at on a pending invite, writes an INVITE_REVOKED audit row, and blocks subsequent redemption with invite_revoked", async () => {
    const user = await seedInvitedUser("inv-deact-pending@test.local");
    const { view: inviteView, plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    const [before] = await testDb.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, inviteView.id));
    expect(before?.revoked_at).toBeNull();
    expect(before?.redeemed_at).toBeNull();

    const result = await deactivateUser(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );
    expect(result).not.toBeNull();

    const [after] = await testDb.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, inviteView.id));
    expect(after?.revoked_at).not.toBeNull();

    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user_invite.revoked"), eq(auditLog.resource_id, inviteView.id)),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.tenant_id).toBe(tenantId);
    expect(auditRows[0]?.result).toBe("success");

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_revoked");

    const minted = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(minted.length).toBe(0);
  });
});

describe("redeemInvite — rejects invite for soft-deleted user (H4)", () => {
  test("redeemInvite returns invite_invalid and mints no key when the target user is already soft-deleted", async () => {
    const user = await seedInvitedUser("inv-deleted-user@test.local");
    const { plaintext } = await createInvite(
      { issuer: { kind: "system" }, tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    await testDb.db
      .update(users)
      .set({
        deleted_at: new Date(getTestNow()),
        status: "disabled",
        updated_at: new Date(getTestNow()),
      })
      .where(eq(users.id, user.id));

    const [inviteRow] = await testDb.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.user_id, user.id));
    expect(inviteRow?.revoked_at).toBeNull();
    expect(inviteRow?.redeemed_at).toBeNull();

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_invalid");

    const minted = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(minted.length).toBe(0);
  });
});
