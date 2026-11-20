import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  taskGrants,
  tasks,
  workflowExecutionAuthorities,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { reserveTaskGrantRun, taskGrantRefusal } from "../grants/reservation.ts";
import { grantTaskAuthority, listTaskGrants, previewTaskGrant } from "../grants.ts";
import { FINGERPRINT_A, FINGERPRINT_B, taskGrantFixtures } from "./grants-fixtures.ts";

let ctx: TestDb;

const f = taskGrantFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("task_grants_supersede");
});

afterAll(async () => {
  await ctx.cleanup();
});

type Person = Awaited<ReturnType<typeof f.person>>;

async function input(
  task_id: string,
  person: Person,
  limits: { valid_until?: string | null; max_runs?: number | null } = {},
) {
  const preview = await previewTaskGrant(task_id, person.context);
  return {
    expected_fingerprint: preview.fingerprint,
    valid_until: limits.valid_until ?? null,
    max_runs: limits.max_runs ?? null,
    expected_workflow_digests: Object.fromEntries(
      preview.workflows.flatMap((workflow) =>
        workflow.effect_manifest_digest
          ? [[workflow.workflow_id, workflow.effect_manifest_digest]]
          : [],
      ),
    ),
  };
}

function authoritiesOf(tenant_id: string) {
  return ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.tenant_id, tenant_id));
}

async function code(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code ?? (error as Error).message;
  }
  return "resolved";
}

async function scenario() {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const workflow = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, owner.user.id, [workflow.id]);
  return { tenant, owner, workflow, task };
}

test("a second grant supersedes the first and an identical live grant is returned unchanged", async () => {
  const s = await scenario();
  const first = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner),
    s.owner.context,
  );
  const same = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner),
    s.owner.context,
  );
  expect(same).toMatchObject({ changed: false, grant: { id: first.grant.id } });
  expect(same.workflows).toEqual([
    {
      workflow_id: s.workflow.id,
      outcome: "covered",
      authority_id: first.grant.workflow_authority_ids[0] as string,
      reason: null,
    },
  ]);
  expect(await listTaskGrants(s.task.id, s.owner.context)).toHaveLength(1);
  const second = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner, { max_runs: 3 }),
    s.owner.context,
  );
  expect(second.changed).toBe(true);
  expect(second.superseded_grant_ids).toEqual([first.grant.id]);
  const grants = await listTaskGrants(s.task.id, s.owner.context);
  expect(grants.filter((grant) => grant.revoked_at === null).map((grant) => grant.id)).toEqual([
    second.grant.id,
  ]);
  const rows = new Map((await authoritiesOf(s.tenant.id)).map((row) => [row.id, row]));
  expect(rows.size).toBe(2);
  expect(rows.get(first.grant.workflow_authority_ids[0] as string)?.revoked_at).not.toBeNull();
  expect(rows.get(second.grant.workflow_authority_ids[0] as string)).toMatchObject({
    revoked_at: null,
    max_runs: 3,
    valid_until: null,
  });
  const audits = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, s.tenant.id), eq(auditLog.action, "task.authority_revoked")));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actor_id: s.owner.user.id, resource_id: first.grant.id });
  expect(audits[0]?.metadata).toMatchObject({ reason_code: "superseded" });
});

test("granting again replaces a grant that is merely expired or exhausted", async () => {
  const s = await scenario();
  const now = await databaseNow(ctx.db);
  const first = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner, {
      valid_until: new Date(now.getTime() + 86_400_000).toISOString(),
    }),
    s.owner.context,
  );
  await ctx.db
    .update(taskGrants)
    .set({
      valid_from: new Date(now.getTime() - 2 * 86_400_000),
      valid_until: new Date(now.getTime() - 86_400_000),
    })
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, first.grant.id)));
  const second = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner, { max_runs: 1 }),
    s.owner.context,
  );
  expect(second.superseded_grant_ids).toEqual([first.grant.id]);
  expect(
    (await reserveTaskGrantRun(ctx.db, { tenant_id: s.tenant.id, grant_id: second.grant.id }))
      .reserved,
  ).toBe(true);
  const third = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner, { max_runs: 1 }),
    s.owner.context,
  );
  expect(third.changed).toBe(true);
  expect(third.superseded_grant_ids).toEqual([second.grant.id]);
  expect(third.grant.reserved_runs).toBe(0);
  const live = (await listTaskGrants(s.task.id, s.owner.context)).filter(
    (grant) => grant.revoked_at === null,
  );
  expect(live.map((grant) => grant.id)).toEqual([third.grant.id]);
});

test("task:grant without workflow:write creates the task grant but no workflow authority", async () => {
  const tenant = await f.tenant();
  const grantor = await f.person(tenant.id, ["task:grant", "task:read", "workflow:read"]);
  const workflow = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, grantor.user.id, [workflow.id]);
  const preview = await previewTaskGrant(task.id, grantor.context);
  expect(preview.workflows[0]).toMatchObject({ blocked_reason: null, may_grant: false });
  const result = await grantTaskAuthority(task.id, await input(task.id, grantor), grantor.context);
  expect(result.workflows).toEqual([
    {
      workflow_id: workflow.id,
      outcome: "not_granted",
      authority_id: null,
      reason: "workflow_permission_missing",
    },
  ]);
  expect(result.grant.workflow_authority_ids).toEqual([]);
  expect(await authoritiesOf(tenant.id)).toHaveLength(0);
});

test("a workflow whose effect changed since the preview refuses the whole grant", async () => {
  const s = await scenario();
  const reviewed = await input(s.task.id, s.owner);
  expect(
    await code(
      grantTaskAuthority(
        s.task.id,
        { ...reviewed, expected_workflow_digests: {} },
        s.owner.context,
      ),
    ),
  ).toBe("task_grant_preview_changed");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "changed",
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: "https://example.test/other",
            body: { recipient: "someone-else@example.test" },
          },
        ],
      },
    })
    .where(
      and(
        eq(workflowVersions.tenant_id, s.tenant.id),
        eq(workflowVersions.id, s.workflow.version_id),
      ),
    );
  expect(await code(grantTaskAuthority(s.task.id, reviewed, s.owner.context))).toBe(
    "task_grant_preview_changed",
  );
  expect(await listTaskGrants(s.task.id, s.owner.context)).toHaveLength(0);
  expect(await authoritiesOf(s.tenant.id)).toHaveLength(0);
  const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, s.tenant.id));
  expect(audits.filter((row) => row.action.includes("authority"))).toHaveLength(0);
});

test("the window follows the workflow authority rule and an open-ended grant creates open-ended authorities", async () => {
  const s = await scenario();
  const now = await databaseNow(ctx.db);
  for (const valid_until of [
    new Date(now.getTime() + 32 * 86_400_000).toISOString(),
    new Date(now.getTime() - 1000).toISOString(),
  ])
    expect(
      await code(
        grantTaskAuthority(
          s.task.id,
          await input(s.task.id, s.owner, { valid_until }),
          s.owner.context,
        ),
      ),
    ).toBe("authority_window_invalid");
  const result = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner),
    s.owner.context,
  );
  const [authority] = await authoritiesOf(s.tenant.id);
  expect(authority).toMatchObject({
    id: result.grant.workflow_authority_ids[0],
    valid_until: null,
    max_runs: null,
  });
  await ctx.db
    .update(tasks)
    .set({ lifecycle: "archived" })
    .where(and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id)));
  expect(
    await code(
      grantTaskAuthority(
        s.task.id,
        await input(s.task.id, s.owner, { max_runs: 2 }),
        s.owner.context,
      ),
    ),
  ).toBe("task_not_grantable");
});

test("two parallel reservations on a one-run grant: exactly one succeeds", async () => {
  const s = await scenario();
  const { grant } = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner, { max_runs: 1 }),
    s.owner.context,
  );
  const ref = { tenant_id: s.tenant.id, grant_id: grant.id };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveTaskGrantRun(ctx.db, ref)),
  );
  expect(results.filter((result) => result.reserved)).toHaveLength(1);
  expect(results.find((result) => result.reserved)).toMatchObject({ exhausted: true });
  expect(results.filter((result) => !result.reserved)).toHaveLength(7);
  for (const result of results) if (!result.reserved) expect(result.reason).toBe("grant_exhausted");
  const [row] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, grant.id)));
  expect(row?.reserved_runs).toBe(1);
});

test("a reservation is refused for a changed task, an expired window, a revoked grant and another tenant", async () => {
  const s = await scenario();
  const { grant } = await grantTaskAuthority(
    s.task.id,
    await input(s.task.id, s.owner),
    s.owner.context,
  );
  const ref = { tenant_id: s.tenant.id, grant_id: grant.id };
  const other = await f.tenant();
  expect(await reserveTaskGrantRun(ctx.db, { ...ref, tenant_id: other.id })).toEqual({
    reserved: false,
    reason: "grant_required",
  });
  expect(await taskGrantRefusal(ctx.db, ref)).toBeNull();
  const where = and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id));
  await ctx.db.update(tasks).set({ fingerprint: FINGERPRINT_B }).where(where);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({
    reserved: false,
    reason: "grant_fingerprint_mismatch",
  });
  await ctx.db.update(tasks).set({ fingerprint: FINGERPRINT_A, environment: "prod" }).where(where);
  expect((await reserveTaskGrantRun(ctx.db, ref)).reserved).toBe(false);
  await ctx.db.update(tasks).set({ environment: "dev" }).where(where);
  const grantWhere = and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, grant.id));
  const now = await databaseNow(ctx.db);
  await ctx.db
    .update(taskGrants)
    .set({
      valid_until: new Date(now.getTime() - 1000),
      valid_from: new Date(now.getTime() - 5000),
    })
    .where(grantWhere);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({
    reserved: false,
    reason: "grant_expired",
  });
  await ctx.db.update(taskGrants).set({ valid_until: null }).where(grantWhere);
  expect((await reserveTaskGrantRun(ctx.db, ref)).reserved).toBe(true);
  await ctx.db
    .update(taskGrants)
    .set({ revoked_at: sql`clock_timestamp()`, revoked_by: s.owner.user.id })
    .where(grantWhere);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({
    reserved: false,
    reason: "grant_required",
  });
  const [row] = await ctx.db.select().from(taskGrants).where(grantWhere);
  expect(row?.reserved_runs).toBe(1);
});
