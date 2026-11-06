import { afterAll, beforeAll, expect } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema/index.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let ctx: HttpTestServer;

function headers(key = ctx.apiKey): HeadersInit {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export async function request(
  path: string,
  method: string,
  body?: unknown,
  key?: string,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function testKey(value: string): {
  plaintext: string;
  prefix: string;
  token_sha256: string;
} {
  return {
    plaintext: value,
    prefix: value.slice(0, 12),
    token_sha256: createHash("sha256").update(value).digest("hex"),
  };
}

export function browserHeaders(userId: string): Promise<HeadersInit> {
  return browserSessionHeaders(ctx, userId);
}

export async function browserRequest(
  path: string,
  body: unknown,
  browser: HeadersInit,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: browser,
    body: JSON.stringify(body),
  });
}

let roleCounter = 0;

export async function browserPersona(permissions: string[]): Promise<HeadersInit> {
  roleCounter += 1;
  const role = await createRole(ctx.db, ctx.tenantId, `intake-confirm-${roleCounter}`);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `intake-confirm-${roleCounter}@test.local`,
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("missing persona user");
  await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  return browserHeaders(user.id);
}

export async function issueUserKey(name: string, scopes: string[]): Promise<string> {
  const response = await request("/v1/identity/api-keys", "POST", {
    owner_kind: "user",
    owner_id: ctx.userId,
    name,
    scopes,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { plaintext_key: string }).plaintext_key;
}

export function setupIntakeHttp(): void {
  roleCounter = 0;
  beforeAll(async () => {
    ctx = await createHttpTestServer("intake-http");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
}
