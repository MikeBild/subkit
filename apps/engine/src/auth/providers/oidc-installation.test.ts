import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cockpitInstallations } from "../../db/schema/cockpit-installations.ts";
import { sessions, tenants, userIdentities, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createOidcProvider } from "./oidc.ts";
import { type MockOidcHandle, startMockOidc } from "./tests/fixtures/mock-oidc.ts";

let testDb: TestDb;
let mock: MockOidcHandle;
let tenantId = "";

const CLIENT_ID = "installation-mock-client";
const REDIRECT_URI = "http://127.0.0.1:0/v1/identity/login/callback";

beforeAll(async () => {
  testDb = await createTestDb("oidc-installation");
  mock = await startMockOidc();
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "oidc-installation", display_name: "OIDC Installation" })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  try {
    await mock.stop();
  } catch {}
  if (testDb) await testDb.cleanup();
});

async function seedInstallation(subject: string) {
  const [owner] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: `${subject}@test.local`,
      role_id: await builtinRoleId(testDb.db, "member"),
    })
    .returning();
  if (!owner) throw new Error("owner seed failed");
  await testDb.db.insert(userIdentities).values({
    tenant_id: tenantId,
    user_id: owner.id,
    provider_id: "oidc",
    subject,
    email: owner.email,
    issuer_url: mock.url,
  });
  const [installation] = await testDb.db
    .insert(cockpitInstallations)
    .values({ tenant_id: tenantId, owner_user_id: owner.id })
    .returning();
  if (!installation) throw new Error("installation seed failed");
  return { owner, installation };
}

function installationProvider(installationId: string) {
  return createOidcProvider({
    db: testDb.db,
    issuerUrl: mock.url,
    clientId: CLIENT_ID,
    clientSecret: "mock-secret",
    redirectUri: REDIRECT_URI,
    installationId,
  });
}

async function beginInstallationLogin(installationId: string) {
  const provider = installationProvider(installationId);
  const started = await provider.startLogin!(
    new Request(
      `http://127.0.0.1:0/v1/identity/login/start?redirect_to=${encodeURIComponent(`/cockpit/i/${installationId}/`)}`,
      { headers: { accept: "application/json" } },
    ),
  );
  expect(started.status).toBe(302);
  const authorizeUrl = new URL(started.headers.get("location") ?? "");
  const state = authorizeUrl.searchParams.get("state") ?? "";
  expect(state).not.toBe("");
  await fetch(authorizeUrl, { redirect: "manual" });
  return { provider, state };
}

describe("OIDC Cockpit installation login", () => {
  test("reauthenticates only the exact owner identity without provisioning", async () => {
    const { owner, installation } = await seedInstallation("installation-owner");
    const beforeUsers = await testDb.db.select({ id: users.id }).from(users);
    const { provider, state } = await beginInstallationLogin(installation.id);
    const issued = mock.issueFor(
      { sub: "installation-owner", email: "different-email@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );

    const finished = await provider.finishLogin!(
      new Request(issued.callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(finished.status).toBe(302);
    expect(finished.headers.get("set-cookie")).toContain(`subkit_installation_${installation.id}=`);
    expect((await testDb.db.select({ id: users.id }).from(users)).map((user) => user.id)).toEqual(
      beforeUsers.map((user) => user.id),
    );
    const [session] = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.installation_id, installation.id));
    expect(session?.user_id).toBe(owner.id);
  });

  test("rejects a different OIDC subject", async () => {
    const { installation } = await seedInstallation("installation-subject-owner");
    const { provider, state } = await beginInstallationLogin(installation.id);
    const issued = mock.issueFor(
      { sub: "installation-subject-attacker", email: "attacker@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );

    const finished = await provider.finishLogin!(
      new Request(issued.callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(finished.status).toBe(403);
    expect(await finished.json()).toMatchObject({ code: "installation_identity_mismatch" });
  });

  test("rejects an installation revoked between login start and callback", async () => {
    const { installation } = await seedInstallation("installation-revoked-owner");
    const { provider, state } = await beginInstallationLogin(installation.id);
    await testDb.db
      .update(cockpitInstallations)
      .set({ revoked_at: new Date(getTestNow()) })
      .where(eq(cockpitInstallations.id, installation.id));
    const issued = mock.issueFor(
      { sub: "installation-revoked-owner", email: "owner@test.local" },
      { state, redirect_uri: REDIRECT_URI },
    );

    const finished = await provider.finishLogin!(
      new Request(issued.callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(finished.status).toBe(403);
    expect(await finished.json()).toMatchObject({ code: "installation_unavailable" });
  });
});
