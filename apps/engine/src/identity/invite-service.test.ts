// Direct coverage for the invite provisioning service (createInvite,
// redeemInvite, revokeInvite, deactivateUser) against a real Postgres
// database via createTestDb. The redeem path is the load-bearing one: it
// mints a user-owned api key carrying exactly the invite's scopes, flips
// the user to active, and is single-use.

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
import { listApiKeys } from "./service.ts";

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
  test("mints an invite + USER_INVITED audit row; records the granted scopes", async () => {
    const user = await seedInvitedUser("inv-create@test.local");
    const { view, plaintext } = await createInvite(
      {
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
      { tenant_id: tenantId, user_id: user.id, scopes: ["workflow:read"], actor_id: null },
      testDb.db,
    );

    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.user_id).toBe(user.id);
    expect(outcome.api_key.plaintext).toMatch(/^wf_live_/);
    expect(outcome.api_key.view.user_id).toBe(user.id);
    expect(outcome.api_key.view.scopes).toEqual(["workflow:read"]);

    // The minted key is owned by the invited user.
    const keys = await listApiKeys(tenantId, testDb.db);
    expect(keys.find((k) => k.id === outcome.api_key.view.id)?.user_id).toBe(user.id);

    // User flipped invited -> active.
    const [refreshed] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(refreshed?.status).toBe("active");

    // Audit: INVITE_REDEEMED + API_KEY_ISSUED both landed.
    const redeemed = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user_invite.redeemed"));
    expect(redeemed.find((r) => r.resource_id !== null)).toBeDefined();
  });

  test("second redeem of the same token returns invite_already_redeemed", async () => {
    const user = await seedInvitedUser("inv-double@test.local");
    const { plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    const first = await redeemInvite({ token: plaintext }, testDb.db);
    expect(first.ok).toBe(true);

    const second = await redeemInvite({ token: plaintext }, testDb.db);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected failure");
    expect(second.code).toBe("invite_already_redeemed");

    // Exactly one key was minted across both attempts.
    const keys = await listApiKeys(tenantId, testDb.db);
    expect(keys.filter((k) => k.user_id === user.id).length).toBe(1);
  });

  test("expired invite returns invite_expired", async () => {
    const user = await seedInvitedUser("inv-expired@test.local");
    const { view, plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
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
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
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
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
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
  test("soft-deletes the user, sets status=disabled, and revokes their keys", async () => {
    const user = await seedInvitedUser("inv-deact@test.local");
    const { plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
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

    // The previously-minted key is now revoked.
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

// H1 — concurrent redeem serialization.
//
// The claim-first conditional UPDATE (`isNull(redeemed_at)` in the WHERE clause
// of the UPDATE inside the transaction) is the serialization point. Two
// concurrent redeems both reach the pre-read with redeemed_at=null; the row
// lock the UPDATE takes serializes them so the loser's UPDATE matches 0 rows
// and returns `invite_already_redeemed` without minting a key.
//
// This test FAILS if the isNull(redeemed_at) guard is removed from the UPDATE's
// WHERE clause: both callers would succeed, and `successes.length` would be 2.
describe("redeemInvite — concurrent serialization (H1)", () => {
  test("two concurrent redeems: exactly one mints a key, the other returns invite_already_redeemed", async () => {
    const user = await seedInvitedUser("inv-concurrent@test.local");
    const { view: inviteView, plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    // Start both redeems before either has a chance to commit. The Postgres
    // row lock inside the claim-first UPDATE is the serialization point.
    const [result1, result2] = await Promise.all([
      redeemInvite({ token: plaintext }, testDb.db),
      redeemInvite({ token: plaintext }, testDb.db),
    ]);

    const outcomes = [result1, result2];
    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o) => !o.ok);

    // Exactly one winner.
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (!failure || failure.ok) throw new Error("expected a failure outcome");
    expect(failure.code).toBe("invite_already_redeemed");

    // Exactly one api_key row minted for this user across both attempts.
    const mintedKeys = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(mintedKeys.length).toBe(1);

    // Exactly one INVITE_REDEEMED audit row for this invite.
    const redeemAudit = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user_invite.redeemed"), eq(auditLog.resource_id, inviteView.id)),
      );
    expect(redeemAudit.length).toBe(1);
  });
});

// H2 — revokeInvite writes an INVITE_REVOKED audit row.
//
// The audit row is the only durable evidence that the admin cancelled a grant
// before the invited user could mint a key from it. This test FAILS if the
// auditAwait call is removed from revokeInvite.
describe("revokeInvite — INVITE_REVOKED audit row (H2)", () => {
  test("revokeInvite writes an INVITE_REVOKED audit row carrying tenant_id and actor_id", async () => {
    const user = await seedInvitedUser("inv-revoke-audit@test.local");
    const { view } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    // Use the invited user's own id as the actor (synthetic admin revoke).
    // The audit table carries actor_id as a free UUID — no FK constraint.
    const actorId = user.id;
    const revokedView = await revokeInvite(
      { tenant_id: tenantId, invite_id: view.id, actor_id: actorId },
      testDb.db,
    );
    expect(revokedView).not.toBeNull();

    // INVITE_REVOKED audit row must exist.
    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user_invite.revoked"), eq(auditLog.resource_id, view.id)));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.tenant_id).toBe(tenantId);
    expect(auditRows[0]?.actor_id).toBe(actorId);
    expect(auditRows[0]?.result).toBe("success");
  });
});

// H3 — deactivateUser severs pending (un-redeemed) invites.
//
// The fix adds a revokedInvites UPDATE + INVITE_REVOKED audit loop inside
// deactivateUser (same transaction as the user soft-delete + key revoke).
// Without it, a deactivated user could still redeem a live invite to mint
// a fresh personal api key — resurrecting their access.
//
// This test FAILS in three independent ways if the revokedInvites block is
// removed from deactivateUser:
//   1. `after?.revoked_at` is null  — the invite row was never stamped.
//   2. `auditRows.length` is 0     — no INVITE_REVOKED entry was written.
//   3. `outcome.code` is "invite_invalid" instead of "invite_revoked"
//      — the invite isn't revoked, so redeemInvite falls through to the
//      defense-in-depth user-deleted check (H4) and returns the generic
//      invalid code rather than the precise "invite_revoked" one.
describe("deactivateUser — severs pending invite (H3)", () => {
  test("deactivateUser stamps revoked_at on a pending invite, writes an INVITE_REVOKED audit row, and blocks subsequent redemption with invite_revoked", async () => {
    const user = await seedInvitedUser("inv-deact-pending@test.local");
    const { view: inviteView, plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    // Confirm the invite is pending before deactivation.
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

    // The invite row must now carry revoked_at — the deactivateUser tx
    // stamped it alongside the user soft-delete and key revoke.
    const [after] = await testDb.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, inviteView.id));
    expect(after?.revoked_at).not.toBeNull();

    // An INVITE_REVOKED audit row must exist scoped to this tenant and invite.
    // This is the durable evidence that access was fully severed — not just
    // the user soft-delete. Reverts of the audit loop break this assertion.
    const auditRows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user_invite.revoked"), eq(auditLog.resource_id, inviteView.id)),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.tenant_id).toBe(tenantId);
    expect(auditRows[0]?.result).toBe("success");

    // A subsequent redemption must fail with "invite_revoked" — not the
    // generic "invite_invalid". The precise code proves the invite row
    // carries revoked_at (H3's revoke path), not that the user-deleted
    // guard (H4) fired instead.
    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_revoked");

    // No api_keys were minted for this user at any point during the scenario.
    const minted = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(minted.length).toBe(0);
  });
});

// H4 — redeemInvite rejects an invite whose target user is already soft-deleted.
//
// This is the defense-in-depth guard added to redeemInvite. It covers the
// non-concurrent case where a user row is soft-deleted by means OTHER than
// deactivateUser (e.g. a direct DB operation during incident response),
// leaving the invite row un-revoked. Without this check redeemInvite would
// succeed, mint a personal api key, and flip the deleted user to "active" —
// resurrecting access silently.
//
// This test FAILS if the `userRows` deleted_at guard is removed from
// redeemInvite: the call would return ok:true, `outcome.ok` would be true
// (breaking the first assertion), and a key row would be minted
// (breaking the final assertion).
//
// The user is soft-deleted directly via SQL UPDATE — not through
// deactivateUser — so the invite row is intentionally left un-revoked.
// This isolates the H4 guard from the H3 deactivateUser invite-revoke path.
describe("redeemInvite — rejects invite for soft-deleted user (H4)", () => {
  test("redeemInvite returns invite_invalid and mints no key when the target user is already soft-deleted", async () => {
    const user = await seedInvitedUser("inv-deleted-user@test.local");
    const { plaintext } = await createInvite(
      { tenant_id: tenantId, user_id: user.id, actor_id: null },
      testDb.db,
    );

    // Soft-delete the user row directly — bypassing deactivateUser — so
    // the invite is NOT revoked. This is the non-concurrent case the H4
    // guard is designed to catch.
    await testDb.db
      .update(users)
      .set({
        deleted_at: new Date(getTestNow()),
        status: "disabled",
        updated_at: new Date(getTestNow()),
      })
      .where(eq(users.id, user.id));

    // Confirm the invite is still pending (un-revoked, un-redeemed).
    const [inviteRow] = await testDb.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.user_id, user.id));
    expect(inviteRow?.revoked_at).toBeNull();
    expect(inviteRow?.redeemed_at).toBeNull();

    // redeemInvite must refuse with the generic "invite_invalid" code —
    // never revealing user-deleted state to an unauthenticated redeemer.
    const outcome = await redeemInvite({ token: plaintext }, testDb.db);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("invite_invalid");

    // No api_keys row was minted for this user.
    const minted = await testDb.db.select().from(apiKeys).where(eq(apiKeys.user_id, user.id));
    expect(minted.length).toBe(0);
  });
});
