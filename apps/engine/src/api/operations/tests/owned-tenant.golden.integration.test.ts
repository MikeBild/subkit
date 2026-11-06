import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../../auth/browser-session.ts";
import { getConfig, setConfigKey } from "../../../config/loader.ts";
import { auditLog, sessions, tenants, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/owned-tenant.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

let ctx: HttpTestServer;
let ownerIdentityId: string;
let displayName: string;

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/"prefix":"[^"]*"/g, '"prefix":"<prefix>"')
    .replace(UUID, "<id>");
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; cache_control: string | null; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    cache_control: res.headers.get("cache-control"),
    body: text ? JSON.parse(text) : null,
  };
}

async function sessionHeaders(userId: string, authIdentityId: string | null) {
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      auth_identity_id: authIdentityId,
      expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      absolute_expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("missing owned tenant session");
  const payload = { tenant_id: ctx.tenantId, user_id: userId, session_id: session.id };
  return {
    cookie: browserSessionCookie(await signBrowserSession(payload)),
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "x-subkit-tenant": ctx.tenantId,
  };
}

async function addUser(email: string, authIdentityId: string | null): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email,
      auth_identity_id: authIdentityId,
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("missing owned tenant user");
  return user.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_owned_tenant_golden", { hosted: true });
  for (const key of Object.keys(getConfig().server.hosted_rate_limit))
    await setConfigKey(`server.hosted_rate_limit.${key}`, 10000);
  const [tenant] = await ctx.db
    .select({ owner: tenants.owner_identity_id, display_name: tenants.display_name })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId));
  if (!tenant?.owner) throw new Error("hosted tenant has no owner identity");
  ownerIdentityId = tenant.owner;
  displayName = tenant.display_name;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 60_000);

describe("owned tenant routes keep their HTTP responses byte for byte", () => {
  test("read refuses credentials without a verified owner browser identity", async () => {
    const bearer = { authorization: `Bearer ${ctx.apiKey}` };
    record("http.read.api-key", await http("GET", "/v1/identity/owned-tenant", bearer));
    record("http.read.unauthenticated", await http("GET", "/v1/identity/owned-tenant", {}));
    const plain = await sessionHeaders(ctx.userId, null);
    record(
      "http.read.session-without-identity",
      await http("GET", "/v1/identity/owned-tenant", plain),
    );
    record(
      "http.deletion.api-key",
      await http("POST", "/v1/identity/owned-tenant/deletion", bearer, {
        confirmation: displayName,
      }),
    );
    record(
      "http.deletion.session-without-identity",
      await http("POST", "/v1/identity/owned-tenant/deletion", plain, {
        confirmation: displayName,
      }),
    );
  });

  test("the owner reads the tenant and requests its deletion", async () => {
    const ownerId = await addUser("owned-tenant-owner@example.test", ownerIdentityId);
    const owner = await sessionHeaders(ownerId, ownerIdentityId);
    record("http.read.owner", await http("GET", "/v1/identity/owned-tenant", owner));
    record(
      "http.deletion.invalid-body",
      await http("POST", "/v1/identity/owned-tenant/deletion", owner, { confirmation: "" }),
    );
    record(
      "http.deletion.extra-field",
      await http("POST", "/v1/identity/owned-tenant/deletion", owner, {
        confirmation: displayName,
        force: true,
      }),
    );
    record(
      "http.deletion.mismatch",
      await http("POST", "/v1/identity/owned-tenant/deletion", owner, {
        confirmation: "wrong confirmation",
      }),
    );
    record(
      "http.deletion.owner",
      await http("POST", "/v1/identity/owned-tenant/deletion", owner, {
        confirmation: displayName,
      }),
    );
    record(
      "http.deletion.again",
      await http("POST", "/v1/identity/owned-tenant/deletion", owner, {
        confirmation: displayName,
      }),
    );
    record("http.read.after-deletion", await http("GET", "/v1/identity/owned-tenant", owner));
    const rows = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctx.tenantId));
    actual["audit"] = JSON.stringify(rows.map((row) => scrub(row)).sort());
    expect(actual["audit"]).toBe(golden["audit"] as string);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
