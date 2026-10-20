import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { sessions, tenants, users } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { revokeCockpitInstallation } from "../identity/cockpit-installations.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { issueBrowserSession } from "./browser-session.ts";
import { createBrowserSessionProvider } from "./providers/browser-session.ts";

let testDb: TestDb;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("browser-session-concurrency");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "browser-session-concurrency", display_name: "Browser Session Concurrency" })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

async function seedInstallation(label: string) {
  const [owner] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: `${label}@test.local`,
      role_id: await builtinRoleId(testDb.db, "member"),
    })
    .returning();
  if (!owner) throw new Error("owner seed failed");
  const [installation] = await testDb.db
    .insert(cockpitInstallations)
    .values({ tenant_id: tenantId, owner_user_id: owner.id })
    .returning();
  if (!installation) throw new Error("installation seed failed");
  return { installation, owner };
}

function issueFor(installation: { id: string; tenant_id: string; owner_user_id: string }) {
  return issueBrowserSession({
    db: testDb.db,
    tenantId: installation.tenant_id,
    userId: installation.owner_user_id,
    installationId: installation.id,
    redirectTo: `/cockpit/i/${installation.id}/`,
    via: "browser_session_concurrency_test",
  });
}

async function waitForInstallationLockWaiters(expected: number) {
  await waitFor(
    async () => {
      const { rows } = await testDb.pool.query<{ waiting: number }>(
        `SELECT count(*)::integer AS waiting
         FROM pg_catalog.pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%cockpit_installations%'`,
      );
      return rows[0]?.waiting === expected;
    },
    { label: `${expected} Cockpit installation lock waiter(s)`, tries: 1_000, sleepMs: 5 },
  );
}

test("issuance queued before revocation yields a revoked session with no usable principal", async () => {
  const { installation } = await seedInstallation("issue-before-revoke");
  const holder = await testDb.pool.connect();
  let issue: Promise<Response> | undefined;
  let revoke: Promise<boolean> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM subkit.cockpit_installations WHERE id = $1 FOR UPDATE", [
      installation.id,
    ]);
    issue = issueFor(installation);
    await waitForInstallationLockWaiters(1);
    revoke = revokeCockpitInstallation(
      testDb.db,
      installation.id,
      installation.tenant_id,
      installation.owner_user_id,
    );
    await waitForInstallationLockWaiters(2);
    await holder.query("COMMIT");

    const issued = await issue;
    expect(issued.status).toBe(302);
    expect(await revoke).toBe(true);
    const [session] = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.installation_id, installation.id));
    expect(session?.revoked_at).not.toBeNull();
    const cookie = issued.headers.get("set-cookie") ?? "";
    const principal = await createBrowserSessionProvider({ db: testDb.db }).resolve(
      new Request(`http://127.0.0.1:0/cockpit/i/${installation.id}/api/v1/cockpit/bootstrap`, {
        headers: { cookie },
      }),
    );
    expect(principal).toBeNull();
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    if (issue) await issue;
    if (revoke) await revoke;
  }
});

test("issuance blocked behind a committed revocation cannot create a session or cookie", async () => {
  const { installation } = await seedInstallation("revoke-before-issue");
  const revoker = await testDb.pool.connect();
  let issue: Promise<Response> | undefined;
  try {
    await revoker.query("BEGIN");
    await revoker.query("UPDATE subkit.cockpit_installations SET revoked_at = $1 WHERE id = $2", [
      new Date(getTestNow()),
      installation.id,
    ]);
    issue = issueFor(installation);
    await waitForInstallationLockWaiters(1);
    await revoker.query("COMMIT");

    const refused = await issue;
    expect(refused.status).toBe(500);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await refused.json()).toEqual({ code: "session_insert_failed" });
    expect(
      await testDb.db.select().from(sessions).where(eq(sessions.installation_id, installation.id)),
    ).toHaveLength(0);
  } finally {
    await revoker.query("ROLLBACK").catch(() => {});
    revoker.release();
    if (issue) await issue;
  }
});
