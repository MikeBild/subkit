import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  auditLog,
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { listOauthClientsForAdmin, revokeOauthClient } from "./oauth-client-admin.ts";

let tdb: TestDb;
const clock = createDeterministicClock();
let previousClock: ReturnType<typeof installClock>;
let operatorTenantId = "";
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2001-01-01T00:00:00.000Z");

beforeAll(async () => {
  previousClock = installClock(clock);
  tdb = await createTestDb("oauth-client-admin");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  operatorTenantId = (await seedTenant(tdb.db, { is_operator: true })).id;
});
afterAll(async () => {
  restoreClock(previousClock);
  await tdb.cleanup();
});

function principal(tenant_id: string, id: string): ResolvedPrincipal {
  return { provider: "api_key", kind: "user", id, tenant_id, roles: ["admin"] };
}

async function seedPerson(tenant_id: string, email: string): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({ tenant_id, email, role_id: await emptyRoleId(tdb.db, tenant_id) })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

async function seedClient(
  client_id: string,
  overrides: Partial<typeof mcpOauthClients.$inferInsert> = {},
): Promise<string> {
  const [row] = await tdb.db
    .insert(mcpOauthClients)
    .values({
      client_id,
      redirect_uris: ["https://client.example.test/callback"],
      client_name: `Client ${client_id}`,
      ...overrides,
    })
    .returning({ id: mcpOauthClients.id });
  if (!row) throw new Error("client fixture missing");
  return row.id;
}

async function seedGrant(tenant_id: string, client_id: string, user_id: string): Promise<string> {
  const [row] = await tdb.db
    .insert(mcpOauthGrants)
    .values({ tenant_id, client_id, user_id })
    .returning({ id: mcpOauthGrants.id });
  if (!row) throw new Error("grant fixture missing");
  return row.id;
}

async function seedTokens(input: {
  tenant_id: string;
  client_id: string;
  user_id: string;
  grant_id: string | null;
  label: string;
  revoked_at?: Date;
  last_used_at?: Date;
}) {
  const digest = (kind: string) =>
    createHash("sha256").update(`${kind}-${input.label}`).digest("hex");
  await tdb.db.insert(mcpOauthAccessTokens).values({
    tenant_id: input.tenant_id,
    client_id: input.client_id,
    user_id: input.user_id,
    grant_id: input.grant_id,
    prefix: `a-${input.label}`,
    token_sha256: digest("access"),
    scope: "mcp:read",
    expires_at: FUTURE,
    revoked_at: input.revoked_at ?? null,
    last_used_at: input.last_used_at ?? null,
  });
  await tdb.db.insert(mcpOauthRefreshTokens).values({
    tenant_id: input.tenant_id,
    client_id: input.client_id,
    user_id: input.user_id,
    grant_id: input.grant_id,
    prefix: `r-${input.label}`,
    token_sha256: digest("refresh"),
    scope: "mcp:read",
    expires_at: FUTURE,
    revoked_at: input.revoked_at ?? null,
  });
}

async function connect(tenant_id: string, client_id: string, label: string) {
  const user_id = await seedPerson(tenant_id, `${label}@example.test`);
  const grant_id = await seedGrant(tenant_id, client_id, user_id);
  await seedTokens({ tenant_id, client_id, user_id, grant_id, label });
  return { user_id, grant_id };
}

async function tokenState(tenant_id: string, client_id: string) {
  const where = (table: typeof mcpOauthAccessTokens | typeof mcpOauthRefreshTokens) =>
    and(eq(table.tenant_id, tenant_id), eq(table.client_id, client_id));
  const access = await tdb.db
    .select({ revoked_at: mcpOauthAccessTokens.revoked_at })
    .from(mcpOauthAccessTokens)
    .where(where(mcpOauthAccessTokens));
  const refresh = await tdb.db
    .select({ revoked_at: mcpOauthRefreshTokens.revoked_at })
    .from(mcpOauthRefreshTokens)
    .where(where(mcpOauthRefreshTokens));
  const grants = await tdb.db
    .select({ revoked_at: mcpOauthGrants.revoked_at })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.tenant_id, tenant_id), eq(mcpOauthGrants.client_id, client_id)));
  return {
    access: access.map((row) => row.revoked_at?.getTime() ?? null),
    refresh: refresh.map((row) => row.revoked_at?.getTime() ?? null),
    grants: grants.map((row) => row.revoked_at?.getTime() ?? null),
  };
}

async function clientRow(client_id: string) {
  const [row] = await tdb.db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.client_id, client_id));
  if (!row) throw new Error("client row missing");
  return row;
}

async function auditFor(tenant_id: string, actions: string[]) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), inArray(auditLog.action, actions)));
}

async function unknownGrantTenants(client_id: string) {
  const rows = await tdb.db
    .select({ tenant_id: mcpOauthUnknownGrants.tenant_id })
    .from(mcpOauthUnknownGrants)
    .where(eq(mcpOauthUnknownGrants.client_id, client_id));
  return rows.map((row) => row.tenant_id).sort();
}

const REVOCATION_ACTIONS = [
  AuditAction.MCP_OAUTH_TOKEN_REVOKED,
  AuditAction.MCP_OAUTH_CLIENT_DISABLED,
];

describe("listing OAuth clients", () => {
  test("a workspace admin sees only the clients its own tenant has connected", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    await seedClient("list-own");
    await seedClient("list-foreign");
    await seedClient("list-unused");
    await connect(tenant.id, "list-own", "list-own-person");
    await connect(other.id, "list-foreign", "list-foreign-person");

    const listing = await listOauthClientsForAdmin(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000a001"),
      request_source: "api",
    });

    expect(listing.rows.map((row) => row.client_id)).toEqual(["list-own"]);
    const [event] = await auditFor(tenant.id, [AuditAction.MCP_OAUTH_CLIENT_LISTED]);
    expect(event?.actor_type).toBe("user");
    expect(event?.actor_id).toBe("00000000-0000-4000-8000-00000000a001");
    expect(event?.resource_type).toBe("mcp_oauth_client");
    expect(event?.resource_id).toBeNull();
    expect(event?.result).toBe("success");
    expect(event?.metadata).toEqual({ request_source: "api", count: 1 });
  });

  test("the operator sees every registered client engine-wide", async () => {
    await seedClient("op-list-a");
    await seedClient("op-list-b");

    const listing = await listOauthClientsForAdmin(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000a002"),
      request_source: "cli",
    });

    const ids = listing.rows.map((row) => row.client_id);
    expect(ids).toContain("op-list-a");
    expect(ids).toContain("op-list-b");
    const all = await tdb.db.select({ id: mcpOauthClients.id }).from(mcpOauthClients);
    expect(listing.rows).toHaveLength(all.length);
    const events = await auditFor(operatorTenantId, [AuditAction.MCP_OAUTH_CLIENT_LISTED]);
    expect(events.map((event) => event.metadata)).toContainEqual({
      request_source: "cli",
      count: all.length,
    });
  });

  test("listed clients expose only public registration fields", async () => {
    const tenant = await seedTenant(tdb.db);
    await seedClient("list-fields", { scope: "mcp:admin", software_id: "sw-1" });
    await connect(tenant.id, "list-fields", "list-fields-person");

    const listing = await listOauthClientsForAdmin(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000a003"),
      request_source: "api",
    });

    const [row] = listing.rows;
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "client_id",
      "client_name",
      "created_at",
      "disabled_at",
      "id",
      "redirect_uris",
      "registration_source",
      "retired_at",
    ]);
  });

  test("approvals, connected people and last use come from the caller's tenant only", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    await seedClient("list-shared");
    const own = await connect(tenant.id, "list-shared", "shared-own");
    await tdb.db
      .update(mcpOauthAccessTokens)
      .set({ last_used_at: new Date("2030-05-06T07:08:09.000Z") })
      .where(eq(mcpOauthAccessTokens.prefix, "a-shared-own"));
    await connect(other.id, "list-shared", "shared-foreign");

    const listing = await listOauthClientsForAdmin(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000a004"),
      request_source: "api",
    });

    expect(listing.approvals.get("list-shared")).toEqual({
      approved_by: ["shared-own@example.test"],
      live_connections: 1,
    });
    expect(listing.lastUsage.get("list-shared")).toBe("2030-05-06T07:08:09.000Z");
    expect(JSON.stringify([...listing.connectedBy.entries()])).toContain("shared-own@example.test");
    expect(JSON.stringify([...listing.connectedBy.entries()])).not.toContain(
      "shared-foreign@example.test",
    );
    expect(own.grant_id).toBeString();
  });
});

describe("revoking an OAuth client inside a workspace", () => {
  test("an unknown client id answers null and writes nothing", async () => {
    const tenant = await seedTenant(tdb.db);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000b001"),
      request_source: "api",
      client_id: "does-not-exist",
    });

    expect(effect).toBeNull();
    expect(await auditFor(tenant.id, REVOCATION_ACTIONS)).toEqual([]);
  });

  test("a client the workspace never connected answers null and leaves other tenants untouched", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    await seedClient("revoke-foreign");
    await connect(other.id, "revoke-foreign", "revoke-foreign-person");

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000b002"),
      request_source: "api",
      client_id: "revoke-foreign",
    });

    expect(effect).toBeNull();
    expect(await tokenState(other.id, "revoke-foreign")).toEqual({
      access: [null],
      refresh: [null],
      grants: [null],
    });
    expect((await clientRow("revoke-foreign")).disabled_at).toBeNull();
    expect(await auditFor(tenant.id, REVOCATION_ACTIONS)).toEqual([]);
  });

  test("a workspace revoke ends only its own tokens and grants and keeps the client enabled", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    const clientRowId = await seedClient("revoke-own");
    await connect(tenant.id, "revoke-own", "revoke-own-person");
    await connect(other.id, "revoke-own", "revoke-own-foreign");
    const at = clock.advanceBy(1000);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000b003"),
      request_source: "mcp",
      client_id: "revoke-own",
    });

    expect(effect).toBe("tenant_access_revoked");
    expect(await tokenState(tenant.id, "revoke-own")).toEqual({
      access: [at],
      refresh: [at],
      grants: [at],
    });
    expect(await tokenState(other.id, "revoke-own")).toEqual({
      access: [null],
      refresh: [null],
      grants: [null],
    });
    const client = await clientRow("revoke-own");
    expect(client.disabled_at).toBeNull();
    const events = await auditFor(tenant.id, REVOCATION_ACTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe(AuditAction.MCP_OAUTH_TOKEN_REVOKED);
    expect(events[0]?.actor_id).toBe("00000000-0000-4000-8000-00000000b003");
    expect(events[0]?.actor_type).toBe("user");
    expect(events[0]?.resource_type).toBe("mcp_oauth_token");
    expect(events[0]?.resource_id).toBe(clientRowId);
    expect(events[0]?.result).toBe("success");
    expect(events[0]?.metadata).toEqual({
      request_source: "mcp",
      reason: "tenant_access_revoked",
      client_id: "revoke-own",
      access_tokens_revoked: 1,
      refresh_tokens_revoked: 1,
    });
    expect(await auditFor(other.id, REVOCATION_ACTIONS)).toEqual([]);
  });

  test("a workspace admin cannot disable the client for everyone", async () => {
    const tenant = await seedTenant(tdb.db);
    await seedClient("revoke-no-disable");
    await connect(tenant.id, "revoke-no-disable", "revoke-no-disable-person");

    await revokeOauthClient(tdb.db, {
      principal: principal(tenant.id, "00000000-0000-4000-8000-00000000b004"),
      request_source: "api",
      client_id: "revoke-no-disable",
    });

    const events = await auditFor(tenant.id, [AuditAction.MCP_OAUTH_CLIENT_DISABLED]);
    expect(events).toEqual([]);
    expect((await clientRow("revoke-no-disable")).disabled_at).toBeNull();
  });
});

describe("disabling an OAuth client engine-wide", () => {
  test("the operator disables the client and revokes live tokens and grants in every tenant", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    const clientRowId = await seedClient("disable-all", { retired_at: null });
    await connect(tenant.id, "disable-all", "disable-all-a");
    const otherUser = await seedPerson(other.id, "disable-all-b@example.test");
    await seedTokens({
      tenant_id: other.id,
      client_id: "disable-all",
      user_id: otherUser,
      grant_id: null,
      label: "disable-all-b",
    });
    await seedTokens({
      tenant_id: other.id,
      client_id: "disable-all",
      user_id: otherUser,
      grant_id: null,
      label: "disable-all-b-old",
      revoked_at: PAST,
    });
    const at = clock.advanceBy(1000);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c001"),
      request_source: "cli",
      client_id: "disable-all",
    });

    expect(effect).toBe("client_disabled");
    const client = await clientRow("disable-all");
    expect(client.disabled_at?.getTime()).toBe(at);
    expect(client.retired_at).toBeNull();
    expect(await tokenState(tenant.id, "disable-all")).toEqual({
      access: [at],
      refresh: [at],
      grants: [at],
    });
    const otherState = await tokenState(other.id, "disable-all");
    expect(otherState.access.sort()).toEqual([PAST.getTime(), at].sort());
    expect(otherState.refresh.sort()).toEqual([PAST.getTime(), at].sort());
    expect(await unknownGrantTenants("disable-all")).toEqual([other.id]);
    const events = await auditFor(operatorTenantId, REVOCATION_ACTIONS);
    const disabled = events.filter((event) => event.resource_id === clientRowId);
    expect(disabled.map((event) => event.action).sort()).toEqual(
      [AuditAction.MCP_OAUTH_CLIENT_DISABLED, AuditAction.MCP_OAUTH_TOKEN_REVOKED].sort(),
    );
    const disableEvent = disabled.find(
      (event) => event.action === AuditAction.MCP_OAUTH_CLIENT_DISABLED,
    );
    expect(disableEvent?.actor_id).toBe("00000000-0000-4000-8000-00000000c001");
    expect(disableEvent?.actor_type).toBe("user");
    expect(disableEvent?.resource_type).toBe("mcp_oauth_client");
    expect(disableEvent?.result).toBe("success");
    expect(disableEvent?.metadata).toEqual({ client_id: "disable-all", request_source: "cli" });
    const revokeEvent = disabled.find(
      (event) => event.action === AuditAction.MCP_OAUTH_TOKEN_REVOKED,
    );
    expect(revokeEvent?.actor_id).toBe("00000000-0000-4000-8000-00000000c001");
    expect(revokeEvent?.actor_type).toBe("user");
    expect(revokeEvent?.resource_type).toBe("mcp_oauth_token");
    expect(revokeEvent?.result).toBe("success");
    expect(revokeEvent?.metadata).toEqual({
      request_source: "cli",
      reason: "client_disabled",
      client_id: "disable-all",
      access_tokens_revoked: 2,
      refresh_tokens_revoked: 2,
    });
    expect(await auditFor(tenant.id, REVOCATION_ACTIONS)).toEqual([]);
  });

  test("the operator revoking an unknown client answers null and writes nothing", async () => {
    const before = await auditFor(operatorTenantId, REVOCATION_ACTIONS);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c005"),
      request_source: "api",
      client_id: "operator-unknown",
    });

    expect(effect).toBeNull();
    expect(await auditFor(operatorTenantId, REVOCATION_ACTIONS)).toHaveLength(before.length);
  });

  test("disabling an already disabled client changes nothing and writes no audit", async () => {
    const clientRowId = await seedClient("disable-twice");
    await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c002"),
      request_source: "api",
      client_id: "disable-twice",
    });
    const first = (await clientRow("disable-twice")).disabled_at?.getTime();
    clock.advanceBy(5000);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c002"),
      request_source: "api",
      client_id: "disable-twice",
    });

    expect(effect).toBe("client_disabled");
    expect((await clientRow("disable-twice")).disabled_at?.getTime()).toBe(first);
    const events = (await auditFor(operatorTenantId, REVOCATION_ACTIONS)).filter(
      (event) => event.resource_id === clientRowId,
    );
    expect(events).toHaveLength(2);
  });

  test("a retired client is disabled again and loses its retired mark", async () => {
    const clientRowId = await seedClient("disable-retired", {
      disabled_at: PAST,
      retired_at: PAST,
    });
    const at = clock.advanceBy(1000);

    const effect = await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c003"),
      request_source: "api",
      client_id: "disable-retired",
    });

    expect(effect).toBe("client_disabled");
    const client = await clientRow("disable-retired");
    expect(client.disabled_at?.getTime()).toBe(at);
    expect(client.retired_at).toBeNull();
    const events = (await auditFor(operatorTenantId, REVOCATION_ACTIONS)).filter(
      (event) => event.resource_id === clientRowId,
    );
    expect(events).toHaveLength(2);
  });

  test("a tenant whose tokens all carry a grant gets no unknown-grant marker", async () => {
    const tenant = await seedTenant(tdb.db);
    await seedClient("disable-granted");
    await connect(tenant.id, "disable-granted", "disable-granted-person");

    await revokeOauthClient(tdb.db, {
      principal: principal(operatorTenantId, "00000000-0000-4000-8000-00000000c004"),
      request_source: "api",
      client_id: "disable-granted",
    });

    expect(await unknownGrantTenants("disable-granted")).toEqual([]);
  });
});
