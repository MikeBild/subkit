import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  events,
  taskGrants,
  taskRuns,
  tasks,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { carryApprovalsForward } from "../../workflows/authority-inheritance.ts";
import { AUTHORITY_REPLACEMENT_MAX_HOPS } from "../../workflows/core/authority.ts";
import {
  makeWorkflowAuthorityUntilRevoked,
  revokeAuthorityMintedByTaskGrant,
} from "../../workflows/execution-authorities.ts";
import { reserveTaskGrantRun, taskGrantRefusal } from "../grants/reservation.ts";
import { revokeTaskGrantsForTaskLocked } from "../grants/revocation.ts";
import { grantTaskAuthority, previewTaskGrant, revokeTaskAuthority } from "../grants.ts";
import { FINGERPRINT_A, failureCode, taskGrantFixtures } from "./grants-fixtures.ts";

let ctx: TestDb;

const f = taskGrantFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("task_grants_lifecycle");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function scenario(limits: { valid_until?: string | null; max_runs?: number | null } = {}) {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const workflow = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, owner.user.id, [workflow.id]);
  const granted = await grantTaskAuthority(
    task.id,
    await f.reviewed(task.id, owner, limits),
    owner.context,
  );
  const authority_id = granted.grant.workflow_authority_ids[0] as string;
  return { tenant, owner, workflow, task, grant: granted.grant, authority_id };
}

async function activateNextVersion(s: Awaited<ReturnType<typeof scenario>>) {
  const [current] = await ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, s.tenant.id),
        eq(workflowVersions.id, s.workflow.version_id),
      ),
    );
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: s.tenant.id, workflow_id: s.workflow.id, version: 2, dag: current?.dag })
    .returning();
  if (!next) throw new Error("missing next version");
  const carried = await ctx.db.transaction(async (tx) => {
    await tx
      .update(workflows)
      .set({ current_version_id: next.id })
      .where(and(eq(workflows.tenant_id, s.tenant.id), eq(workflows.id, s.workflow.id)));
    return carryApprovalsForward(tx, {
      tenant_id: s.tenant.id,
      workflow_id: s.workflow.id,
      from_version_id: s.workflow.version_id,
      to_version_id: next.id,
      actor_id: s.owner.user.id,
      actor_type: "user",
    });
  });
  const child_id = carried.inherited[0];
  if (!child_id) throw new Error("the approval was not carried forward");
  return child_id;
}

async function liveAuthorityIds(tenant_id: string) {
  return (await f.authorities(tenant_id)).filter((row) => !row.revoked_at).map((row) => row.id);
}

test("revoking the grant revokes the authority that a version activation carried forward", async () => {
  const s = await scenario();
  const child_id = await activateNextVersion(s);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([child_id]);
  const result = await revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context);
  expect(result.revoked_workflow_authority_ids).toEqual([child_id]);
  expect(result.retained_successor_authority_ids).toEqual([]);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([]);
});

test("a successor a person made open-ended on the workflow is kept and reported", async () => {
  const now = await databaseNow(ctx.db);
  const s = await scenario({ valid_until: new Date(now.getTime() + 86_400_000).toISOString() });
  const [minted] = await f.authorities(s.tenant.id);
  const successor = await makeWorkflowAuthorityUntilRevoked(
    s.workflow.id,
    s.authority_id,
    { expected_manifest_digest: minted?.effect_manifest_digest },
    s.owner.context,
  );
  expect(successor.id).not.toBe(s.authority_id);
  const result = await revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context);
  expect(result).toMatchObject({
    revoked_workflow_authority_ids: [],
    retained_successor_authority_ids: [successor.id],
  });
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([successor.id]);
  const [audit] = await f.audits(s.tenant.id, "task.authority_revoked");
  expect(audit?.metadata).toMatchObject({ retained_successor_authority_ids: [successor.id] });
});

test("archive-style revocation by the system leaves no live authority and names the reason", async () => {
  const s = await scenario();
  const child_id = await activateNextVersion(s);
  const results = await ctx.db.transaction((tx) =>
    revokeTaskGrantsForTaskLocked(
      tx,
      { tenant_id: s.tenant.id, task_id: s.task.id },
      { type: "system" },
      "task_archived",
    ),
  );
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    changed: true,
    revoked_workflow_authority_ids: [child_id],
    grant: { id: s.grant.id, revoked_by: s.owner.user.id },
  });
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([]);
  const [grantAudit] = await f.audits(s.tenant.id, "task.authority_revoked");
  expect(grantAudit).toMatchObject({ actor_type: "system", actor_id: null });
  expect(grantAudit?.metadata).toMatchObject({ reason_code: "task_archived" });
  const [authorityAudit] = await f.audits(s.tenant.id, "workflow.authority_revoked");
  expect(authorityAudit).toMatchObject({
    actor_type: "system",
    actor_id: null,
    resource_id: child_id,
  });
  expect(authorityAudit?.metadata).toMatchObject({
    reason_code: "task_archived",
    task_grant_id: s.grant.id,
  });
  expect(
    await ctx.db.transaction((tx) =>
      revokeTaskGrantsForTaskLocked(
        tx,
        { tenant_id: s.tenant.id, task_id: s.task.id },
        { type: "system" },
        "task_archived",
      ),
    ),
  ).toEqual([]);
});

test("a task with grant rows cannot be deleted until the delete path revokes and removes them", async () => {
  const s = await scenario();
  const taskWhere = and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id));
  expect(await failureCode((async () => ctx.db.delete(tasks).where(taskWhere))())).not.toBe(
    "resolved",
  );
  const editor = await f.person(s.tenant.id, "member");
  await ctx.db.transaction(async (tx) => {
    await revokeTaskGrantsForTaskLocked(
      tx,
      { tenant_id: s.tenant.id, task_id: s.task.id },
      { type: "user", id: editor.user.id },
      "task_deleted",
    );
    await tx
      .delete(taskGrants)
      .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.task_id, s.task.id)));
    await tx.delete(tasks).where(taskWhere);
  });
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([]);
  const [authority] = await f.authorities(s.tenant.id);
  expect(authority?.revoked_by).toBe(editor.user.id);
  const [audit] = await f.audits(s.tenant.id, "task.authority_revoked");
  expect(audit).toMatchObject({ actor_type: "user", actor_id: editor.user.id });
  expect(audit?.metadata).toMatchObject({ reason_code: "task_deleted" });
});

test("deleting the tenant still removes tasks and their grants", async () => {
  const s = await scenario();
  await ctx.db.delete(tenants).where(eq(tenants.id, s.tenant.id));
  expect(
    await ctx.db.select().from(taskGrants).where(eq(taskGrants.tenant_id, s.tenant.id)),
  ).toEqual([]);
});

test("the revoke-only seam refuses an authority the grant did not create and an unknown reason", async () => {
  const s = await scenario();
  const other = await scenario();
  const base = {
    tenant_id: s.tenant.id,
    task_grant_id: s.grant.id,
    actor: { type: "system" as const },
  };
  expect(
    await failureCode(
      revokeAuthorityMintedByTaskGrant(ctx.db, {
        ...base,
        origin_authority_id: other.authority_id,
        reason_code: "task_changed",
      }),
    ),
  ).toBe("authority_not_found");
  expect(
    await failureCode(
      revokeAuthorityMintedByTaskGrant(ctx.db, {
        ...base,
        origin_authority_id: s.authority_id,
        reason_code: "anything" as "task_changed",
      }),
    ),
  ).toBe("authority_revocation_reason_required");
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
});

test("an authority another task still relies on is handed over instead of revoked", async () => {
  const s = await scenario();
  const second = await f.task(s.tenant.id, s.owner.user.id, [s.workflow.id]);
  const covered = await grantTaskAuthority(
    second.id,
    await f.reviewed(second.id, s.owner),
    s.owner.context,
  );
  expect(covered.workflows[0]).toMatchObject({ outcome: "covered", authority_id: s.authority_id });
  expect(covered.grant.workflow_authority_ids).toEqual([]);
  const result = await revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context);
  expect(result).toMatchObject({
    revoked_workflow_authority_ids: [],
    transferred_workflow_authority_ids: [s.authority_id],
  });
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
  const [heir] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, covered.grant.id)));
  expect(heir?.workflow_authority_ids).toEqual([s.authority_id]);
  const [audit] = await f.audits(s.tenant.id, "task.authority_revoked");
  expect(audit?.metadata).toMatchObject({
    transferred_workflow_authority_ids: [s.authority_id],
  });
  const last = await revokeTaskAuthority(second.id, covered.grant.id, s.owner.context);
  expect(last.revoked_workflow_authority_ids).toEqual([s.authority_id]);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([]);
});

test("a carried chain longer than the hop cap refuses the revocation instead of leaving a live end", async () => {
  const s = await scenario();
  const [origin] = await f.authorities(s.tenant.id);
  if (!origin) throw new Error("missing authority fixture");
  let parent_id = origin.id;
  const { id: _id, created_at: _created, ...template } = origin;
  for (let hop = 0; hop < AUTHORITY_REPLACEMENT_MAX_HOPS + 2; hop++) {
    const [child] = await ctx.db
      .insert(workflowExecutionAuthorities)
      .values({ ...template, inherited_from: parent_id })
      .returning({ id: workflowExecutionAuthorities.id });
    if (!child) throw new Error("missing chain fixture");
    await ctx.db
      .update(workflowExecutionAuthorities)
      .set({ revoked_at: await databaseNow(ctx.db), superseded_by: child.id })
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, s.tenant.id),
          eq(workflowExecutionAuthorities.id, parent_id),
        ),
      );
    parent_id = child.id;
  }
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([parent_id]);
  expect(await failureCode(revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context))).toBe(
    "authority_chain_too_long",
  );
  expect(
    await failureCode(
      ctx.db.transaction((tx) =>
        revokeTaskGrantsForTaskLocked(
          tx,
          { tenant_id: s.tenant.id, task_id: s.task.id },
          { type: "system" },
          "task_archived",
        ),
      ),
    ),
  ).toBe("authority_chain_too_long");
  const [grant] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, s.grant.id)));
  expect(grant?.revoked_at).toBeNull();
  expect(await f.audits(s.tenant.id, "task.authority_revoked")).toHaveLength(0);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([parent_id]);
});

test("after a handover the old grant no longer names the authority and the seam refuses it", async () => {
  const s = await scenario();
  const second = await f.task(s.tenant.id, s.owner.user.id, [s.workflow.id]);
  const heir = await grantTaskAuthority(
    second.id,
    await f.reviewed(second.id, s.owner),
    s.owner.context,
  );
  const result = await revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context);
  expect(result.transferred_workflow_authority_ids).toEqual([s.authority_id]);
  expect(result.grant.workflow_authority_ids).toEqual([]);
  expect(
    await failureCode(
      revokeAuthorityMintedByTaskGrant(ctx.db, {
        tenant_id: s.tenant.id,
        task_grant_id: s.grant.id,
        origin_authority_id: s.authority_id,
        reason_code: "task_changed",
        actor: { type: "system" },
      }),
    ),
  ).toBe("authority_not_found");
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
  const [row] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, heir.grant.id)));
  expect(row?.workflow_authority_ids).toEqual([s.authority_id]);
});

test("the last reserved run keeps its authorities until the seam is called after the run ended", async () => {
  const s = await scenario({ max_runs: 2 });
  const [minted] = await f.authorities(s.tenant.id);
  expect(minted).toMatchObject({ max_runs: 2, valid_until: null });
  const ref = { tenant_id: s.tenant.id, grant_id: s.grant.id };
  const target = { tenant_id: s.tenant.id, task_id: s.task.id };
  const exhaust = () =>
    ctx.db.transaction((tx) =>
      revokeTaskGrantsForTaskLocked(tx, target, { type: "system" }, "grant_exhausted"),
    );
  expect(await reserveTaskGrantRun(ctx.db, ref)).toMatchObject({
    reserved: true,
    exhausted: false,
  });
  expect(await exhaust()).toEqual([]);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toMatchObject({ reserved: true, exhausted: true });
  const now = await databaseNow(ctx.db);
  const [run] = await ctx.db
    .insert(taskRuns)
    .values({
      tenant_id: s.tenant.id,
      task_id: s.task.id,
      task_revision: 1,
      fingerprint: FINGERPRINT_A,
      trigger: "cron",
      grant_id: s.grant.id,
      state: "running",
      deadline_at: new Date(now.getTime() + 3_600_000),
      trace_id: "d".repeat(32),
    })
    .returning();
  if (!run) throw new Error("missing run fixture");
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
  expect(await f.audits(s.tenant.id, "task.authority_revoked")).toHaveLength(0);
  expect(await taskGrantRefusal(ctx.db, ref)).toBe("grant_exhausted");
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({
    reserved: false,
    reason: "grant_exhausted",
  });
  expect(await exhaust()).toEqual([]);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
  await ctx.db
    .update(taskRuns)
    .set({ state: "completed" })
    .where(and(eq(taskRuns.tenant_id, s.tenant.id), eq(taskRuns.id, run.id)));
  const results = await exhaust();
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    changed: true,
    revoked_workflow_authority_ids: [s.authority_id],
    grant: { id: s.grant.id, reserved_runs: 2 },
  });
  expect(results[0]?.grant.revoked_at).not.toBeNull();
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([]);
  const [audit] = await f.audits(s.tenant.id, "task.authority_revoked");
  expect(audit).toMatchObject({ actor_type: "system", resource_id: s.grant.id });
  expect(audit?.metadata).toMatchObject({ reason_code: "grant_exhausted" });
  expect(await exhaust()).toEqual([]);
});

test("a paused or archived task refuses the reservation with the paused reason", async () => {
  const s = await scenario();
  const ref = { tenant_id: s.tenant.id, grant_id: s.grant.id };
  const where = and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id));
  await ctx.db
    .update(tasks)
    .set({ paused_at: await databaseNow(ctx.db), paused_reason: "owner_request" })
    .where(where);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({ reserved: false, reason: "paused" });
  expect(await taskGrantRefusal(ctx.db, ref)).toBe("paused");
  await ctx.db.update(tasks).set({ paused_at: null, paused_reason: null }).where(where);
  await ctx.db.update(tasks).set({ lifecycle: "archived" }).where(where);
  expect(await reserveTaskGrantRun(ctx.db, ref)).toEqual({ reserved: false, reason: "paused" });
  await ctx.db.update(tasks).set({ lifecycle: "active" }).where(where);
  expect((await reserveTaskGrantRun(ctx.db, ref)).reserved).toBe(true);
});

test("a reservation taken with the task lock and the run row rolls back when the start fails", async () => {
  const s = await scenario({ max_runs: 1 });
  const ref = { tenant_id: s.tenant.id, grant_id: s.grant.id };
  const start = (fail: boolean) =>
    ctx.db.transaction(async (tx) => {
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id)))
        .for("update");
      const reservation = await reserveTaskGrantRun(tx, ref);
      if (!reservation.reserved) throw new Error(reservation.reason);
      const now = await databaseNow(tx);
      const [run] = await tx
        .insert(taskRuns)
        .values({
          tenant_id: s.tenant.id,
          task_id: s.task.id,
          task_revision: 1,
          fingerprint: FINGERPRINT_A,
          trigger: "cron",
          grant_id: reservation.grant.id,
          state: "running",
          deadline_at: new Date(now.getTime() + 3_600_000),
          trace_id: "c".repeat(32),
        })
        .returning();
      if (fail) throw new Error("start failed");
      return run;
    });
  await expect(start(true)).rejects.toThrow("start failed");
  const grantWhere = and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, s.grant.id));
  expect((await ctx.db.select().from(taskGrants).where(grantWhere))[0]?.reserved_runs).toBe(0);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([s.authority_id]);
  expect((await start(false))?.grant_id).toBe(s.grant.id);
  expect((await ctx.db.select().from(taskGrants).where(grantWhere))[0]?.reserved_runs).toBe(1);
});

test("an identical re-grant still co-grants a workflow that became eligible and uncovered", async () => {
  const s = await scenario();
  const first = await revokeAuthorityMintedByTaskGrant(ctx.db, {
    tenant_id: s.tenant.id,
    task_grant_id: s.grant.id,
    origin_authority_id: s.authority_id,
    reason_code: "owner_unavailable",
    actor: { type: "system" },
  });
  expect(first.revoked_authority_id).toBe(s.authority_id);
  const again = await grantTaskAuthority(
    s.task.id,
    await f.reviewed(s.task.id, s.owner),
    s.owner.context,
  );
  expect(again).toMatchObject({ changed: true, grant: { id: s.grant.id } });
  const minted = again.workflows[0]?.authority_id as string;
  expect(again.workflows[0]?.outcome).toBe("granted");
  expect(again.grant.workflow_authority_ids).toEqual([s.authority_id, minted]);
  expect(await liveAuthorityIds(s.tenant.id)).toEqual([minted]);
  const granted = await f.audits(s.tenant.id, "task.authority_granted");
  expect(granted).toHaveLength(2);
  expect(granted.some((row) => (row.metadata as { existing_grant?: boolean }).existing_grant)).toBe(
    true,
  );
});

test("grant and revoke announce task.grant_changed with the task and grant ids", async () => {
  const s = await scenario();
  await revokeTaskAuthority(s.task.id, s.grant.id, s.owner.context);
  const rows = await ctx.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, s.tenant.id), eq(events.type, "task.grant_changed")));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.channel).toBe("resource.lifecycle");
    expect(row.payload).toEqual({ task_id: s.task.id, task_grant_id: s.grant.id });
  }
  expect((await previewTaskGrant(s.task.id, s.owner.context)).live_grant).toBeNull();
});
