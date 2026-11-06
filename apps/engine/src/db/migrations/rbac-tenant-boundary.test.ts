import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { builtinRoleId, createRole } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  systemAccounts,
  tenants,
  users,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let ctx: TestDb;
let localTenant: string;
let foreignTenant: string;
let localUser: string;
let foreignUser: string;
let localGroup: string;
let foreignGroup: string;
let localRole: string;
let foreignRole: string;
let globalRole: string;
let machineId: string;

beforeAll(async () => {
  ctx = await createTestDb("rbac-tenant-boundary");
  const [local, foreign] = await ctx.db
    .insert(tenants)
    .values([
      { slug: "rbac-local", display_name: "Local" },
      { slug: "rbac-foreign", display_name: "Foreign" },
    ])
    .returning();
  if (!local || !foreign) throw new Error("missing tenant fixture");
  localTenant = local.id;
  foreignTenant = foreign.id;
  localRole = (await createRole(ctx.db, localTenant, "local-role")).id;
  foreignRole = (await createRole(ctx.db, foreignTenant, "foreign-role")).id;
  globalRole = await builtinRoleId(ctx.db, "member");
  const [localPerson, foreignPerson] = await ctx.db
    .insert(users)
    .values([
      { tenant_id: localTenant, email: "local@rbac.test", role_id: globalRole },
      { tenant_id: foreignTenant, email: "foreign@rbac.test", role_id: globalRole },
    ])
    .returning();
  const [localTeam, foreignTeam] = await ctx.db
    .insert(groups)
    .values([
      { tenant_id: localTenant, name: "Local" },
      { tenant_id: foreignTenant, name: "Foreign" },
    ])
    .returning();
  const [machine] = await ctx.db
    .insert(systemAccounts)
    .values({ tenant_id: localTenant, name: "machine" })
    .returning();
  if (!localPerson || !foreignPerson || !localTeam || !foreignTeam || !machine)
    throw new Error("missing membership fixture");
  localUser = localPerson.id;
  foreignUser = foreignPerson.id;
  localGroup = localTeam.id;
  foreignGroup = foreignTeam.id;
  machineId = machine.id;
  await ctx.db.insert(groupMembers).values([
    { group_id: localGroup, user_id: localUser },
    { group_id: foreignGroup, user_id: foreignUser },
  ]);
  await ctx.db.insert(groupRoleAssignments).values([
    { group_id: localGroup, role_id: localRole },
    { group_id: localGroup, role_id: globalRole },
    { group_id: foreignGroup, role_id: foreignRole },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

test("database rejects foreign, missing and system-account members and foreign roles on insert and update", async () => {
  for (const userId of [foreignUser, machineId, "10000000-0000-4000-8000-000000000099"]) {
    await expect(
      ctx.pool.query("INSERT INTO subkit.group_members(group_id,user_id) VALUES($1,$2)", [
        localGroup,
        userId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(
    ctx.pool.query("UPDATE subkit.group_members SET user_id=$1 WHERE group_id=$2", [
      foreignUser,
      localGroup,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    ctx.pool.query("INSERT INTO subkit.group_role_assignments(group_id,role_id) VALUES($1,$2)", [
      localGroup,
      foreignRole,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    ctx.pool.query(
      "UPDATE subkit.group_role_assignments SET role_id=$1 WHERE group_id=$2 AND role_id=$3",
      [foreignRole, localGroup, localRole],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("parent tenant transfers reject incompatible bindings including global-role narrowing", async () => {
  for (const [table, id] of [
    ["groups", localGroup],
    ["users", localUser],
    ["roles", localRole],
    ["roles", globalRole],
  ]) {
    await expect(
      ctx.pool.query(`UPDATE subkit.${table} SET tenant_id=$1 WHERE id=$2`, [foreignTenant, id]),
    ).rejects.toMatchObject({ code: "23514" });
  }
  const unbound = (await createRole(ctx.db, localTenant, "unbound")).id;
  await ctx.pool.query("UPDATE subkit.roles SET tenant_id=$1 WHERE id=$2", [
    foreignTenant,
    unbound,
  ]);
  await ctx.pool.query("UPDATE subkit.roles SET tenant_id=NULL WHERE id=$1", [unbound]);
  const [unboundGroup] = await ctx.db
    .insert(groups)
    .values({ tenant_id: localTenant, name: "Unbound" })
    .returning();
  if (!unboundGroup) throw new Error("missing unbound group fixture");
  await ctx.pool.query("UPDATE subkit.groups SET tenant_id=$1 WHERE id=$2", [
    foreignTenant,
    unboundGroup.id,
  ]);
});

test("tenant transfer fails closed at repeatable-read isolation", async () => {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(
      client.query("UPDATE subkit.groups SET tenant_id=$1 WHERE id=$2", [
        foreignTenant,
        localGroup,
      ]),
    ).rejects.toMatchObject({ code: "40001" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("concurrent membership and parent transfer serialize without creating a foreign membership", async () => {
  const [person] = await ctx.db
    .insert(users)
    .values({ tenant_id: localTenant, email: "race@rbac.test", role_id: globalRole })
    .returning();
  if (!person) throw new Error("missing concurrent user fixture");
  const member = await ctx.pool.connect();
  const transfer = await ctx.pool.connect();
  try {
    await member.query("BEGIN");
    await member.query("INSERT INTO subkit.group_members(group_id,user_id) VALUES($1,$2)", [
      localGroup,
      person.id,
    ]);
    await transfer.query("SET statement_timeout='5s'");
    const backend = await transfer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const moved = transfer
      .query("UPDATE subkit.users SET tenant_id=$1 WHERE id=$2", [foreignTenant, person.id])
      .then(
        () => null,
        (error) => error as { code: string },
      );
    await waitFor(
      async () => {
        const result = await ctx.pool.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
          [backend.rows[0]?.pid],
        );
        return result.rows[0]?.blocked;
      },
      { label: "parent transfer waits for membership", sleepMs: 5 },
    );
    await member.query("COMMIT");
    expect(await moved).toMatchObject({ code: "23514" });
    const result = await ctx.pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM subkit.users WHERE id=$1",
      [person.id],
    );
    expect(result.rows[0]?.tenant_id).toBe(localTenant);
  } finally {
    await member.query("ROLLBACK");
    await transfer.query("RESET statement_timeout");
    member.release();
    transfer.release();
  }
});

test("deleting a user cascades only that user's memberships", async () => {
  await ctx.db.delete(users).where(eq(users.id, localUser));
  expect(
    await ctx.db.select().from(groupMembers).where(eq(groupMembers.user_id, localUser)),
  ).toEqual([]);
  expect(
    await ctx.db.select().from(groupMembers).where(eq(groupMembers.user_id, foreignUser)),
  ).toHaveLength(1);
});
