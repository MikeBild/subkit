import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { roles, sessions, users } from "../../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../../db/tests/setup.ts";
import { createEngineCtx, type EngineTestCtx } from "../../../execution/tests/setup.ts";
import { BROWSER_SESSION_COOKIE, signBrowserSession } from "../../browser-session.ts";
import { createBrowserSessionProvider } from "../browser-session.ts";

let ctx: EngineTestCtx;
let roleId: string;
let sequence = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("browser-session-liveness");
  const [role] = await ctx.testDb.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "admin" })
    .returning();
  if (!role) throw new Error("role fixture missing");
  roleId = role.id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function authenticatedRequest() {
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      role_id: roleId,
      status: "active",
      email: `session-liveness-${++sequence}@example.test`,
    })
    .returning();
  if (!user) throw new Error("user fixture missing");
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      product_id: "harmoniqs",
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
      absolute_expires_at: sql`clock_timestamp() + interval '1 hour'`,
      last_seen_at: sql`clock_timestamp()`,
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  const cookie = await signBrowserSession({
    user_id: user.id,
    tenant_id: ctx.tenantId,
    session_id: session.id,
  });
  const request = new Request("http://localhost/v1/executions", {
    headers: { Cookie: `${BROWSER_SESSION_COOKIE}=${cookie}` },
  });
  return { user, session, request };
}

test("a live browser session resolves the active product user", async () => {
  const { user, request } = await authenticatedRequest();
  const principal = await createBrowserSessionProvider({ db: ctx.testDb.db }).resolve(request);
  expect(principal).toMatchObject({
    id: user.id,
    tenant_id: ctx.tenantId,
    product_id: "harmoniqs",
    roles: ["admin"],
  });
});

test("a live browser session cannot authenticate after its user is disabled", async () => {
  const { user, request } = await authenticatedRequest();
  await ctx.testDb.db
    .update(users)
    .set({ status: "disabled" })
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, user.id)));
  const principal = await createBrowserSessionProvider({ db: ctx.testDb.db }).resolve(request);
  expect(principal).toBeNull();
});

test("a live browser session cannot authenticate after its user is deleted", async () => {
  const { user, request } = await authenticatedRequest();
  await ctx.testDb.db
    .update(users)
    .set({ deleted_at: sql`clock_timestamp()` })
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, user.id)));
  const principal = await createBrowserSessionProvider({ db: ctx.testDb.db }).resolve(request);
  expect(principal).toBeNull();
});
