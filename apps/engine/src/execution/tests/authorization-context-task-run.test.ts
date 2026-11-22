import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { taskGrants, taskRuns, tasks, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  authorizationContextFromPrincipal,
  ExecutionAuthorizationContextSchema,
  rehydrateExecutionPrincipal,
} from "../authorization-context.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c);
const FINGERPRINT = "a".repeat(64);
const TRACE = "b".repeat(32);
const AT = new Date("2026-11-19T10:00:00.000Z");
let ctx: EngineTestCtx;

type RunState = (typeof taskRuns.$inferInsert)["state"];

interface Fixture {
  principal: ResolvedPrincipal;
  task_id: string;
  task_run_id: string;
  grant_id: string | null;
  workflow_ids: string[];
  connector_ids: string[];
}

async function insertOwner(tenantId = ctx.tenantId): Promise<{ id: string; email: string }> {
  const [owner] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: `task-owner-${nextUuid()}@example.test`,
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning({ id: users.id, email: users.email });
  if (!owner) throw new Error("owner fixture missing");
  return owner;
}

async function insertTask(
  ownerId: string,
  bindings: { workflow_ids: string[]; connector_ids: string[] },
  tenantId = ctx.tenantId,
): Promise<string> {
  const [task] = await ctx.testDb.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id: tenantId,
      name: "Weekly report",
      owner_id: ownerId,
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { ...bindings, skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
    })
    .returning({ id: tasks.id });
  if (!task) throw new Error("task fixture missing");
  return task.id;
}

async function insertRun(
  taskId: string,
  state: RunState,
  grantId: string | null,
  tenantId = ctx.tenantId,
): Promise<string> {
  const [run] = await ctx.testDb.db
    .insert(taskRuns)
    .values({
      tenant_id: tenantId,
      task_id: taskId,
      task_revision: 1,
      fingerprint: FINGERPRINT,
      trigger: "manual",
      state,
      grant_id: grantId,
      deadline_at: new Date("2026-11-19T14:00:00.000Z"),
      trace_id: TRACE,
    })
    .returning({ id: taskRuns.id });
  if (!run) throw new Error("task run fixture missing");
  return run.id;
}

async function insertGrant(taskId: string, tenantId = ctx.tenantId): Promise<string> {
  const [grant] = await ctx.testDb.db
    .insert(taskGrants)
    .values({
      tenant_id: tenantId,
      task_id: taskId,
      fingerprint: FINGERPRINT,
      environment: "prod",
      created_by: nextUuid(),
    })
    .returning({ id: taskGrants.id });
  if (!grant) throw new Error("task grant fixture missing");
  return grant.id;
}

async function fixture(
  opts: { granted?: boolean; state?: RunState; tenantId?: string } = {},
): Promise<Fixture> {
  const tenantId = opts.tenantId ?? ctx.tenantId;
  const owner = await insertOwner(tenantId);
  const workflow_ids = [nextUuid(), nextUuid()];
  const connector_ids = [nextUuid()];
  const task_id = await insertTask(owner.id, { workflow_ids, connector_ids }, tenantId);
  const grant_id = opts.granted ? await insertGrant(task_id, tenantId) : null;
  const task_run_id = await insertRun(task_id, opts.state ?? "running", grant_id, tenantId);
  return {
    task_id,
    task_run_id,
    grant_id,
    workflow_ids,
    connector_ids,
    principal: {
      provider: "task",
      kind: "user",
      id: owner.id,
      tenant_id: tenantId,
      roles: ["member"],
      email: owner.email,
      allowed_workflows: workflow_ids,
      allowed_connectors: connector_ids,
      auth_source: { kind: "task_run", task_id, task_run_id, grant_id },
    },
  };
}

function persisted(principal: ResolvedPrincipal) {
  const caller = callerFromPrincipal(principal, principal.tenant_id, undefined, "user");
  const authorization = authorizationContextFromPrincipal(principal);
  if (!caller || !authorization) throw new Error("persisted caller fixture missing");
  return { caller, authorization };
}

function rehydrate(caller: unknown, authorization: unknown) {
  return rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization, AT);
}

async function expectRefused(caller: unknown, authorization: unknown): Promise<void> {
  await expect(rehydrate(caller, authorization)).rejects.toMatchObject({
    code: "execution_authentication_unavailable",
  });
}

function taskIs(id: string) {
  return and(eq(tasks.tenant_id, ctx.tenantId), eq(tasks.id, id));
}

beforeAll(async () => {
  ctx = await createEngineCtx("authorization-task-run");
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("rehydrating a task run caller", () => {
  test("an active owner is restored as a task user bound to the task's workflows and connectors", async () => {
    const f = await fixture({ granted: true });
    const { caller, authorization } = persisted(f.principal);
    expect<unknown>(await rehydrate(caller, authorization)).toEqual({
      provider: "task",
      kind: "user",
      id: f.principal.id,
      tenant_id: ctx.tenantId,
      roles: ["member"],
      email: f.principal.email,
      allowed_workflows: f.workflow_ids,
      allowed_connectors: f.connector_ids,
      auth_source: f.principal.auth_source,
    });
  });

  test("a run without a standing grant keeps a null grant id", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    expect<unknown>(authorization.source).toEqual({ ...f.principal.auth_source, grant_id: null });
    const restored = await rehydrate(caller, authorization);
    expect(restored?.auth_source).toEqual(f.principal.auth_source);
    expect(restored?.oauth_client_id).toBeUndefined();
    expect(restored?.scopes).toBeUndefined();
    expect(restored?.session_id).toBeUndefined();
  });

  test("waiting and sleeping runs are restored as well", async () => {
    for (const state of ["waiting", "sleeping"] as const) {
      const f = await fixture({ state });
      const { caller, authorization } = persisted(f.principal);
      expect((await rehydrate(caller, authorization))?.id).toBe(f.principal.id);
    }
  });

  test("it is refused once the owner was deactivated", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, f.principal.id)));
    await expectRefused(caller, authorization);
  });

  test("it is refused once the owner was removed", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db
      .update(users)
      .set({ deleted_at: AT })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, f.principal.id)));
    await expectRefused(caller, authorization);
  });

  test("a task run source is refused for a caller of another provider", async () => {
    const { caller, authorization } = persisted((await fixture()).principal);
    await expectRefused({ ...caller, provider: "oidc" }, authorization);
  });

  test("a task run source is refused for a product caller", async () => {
    const { caller, authorization } = persisted((await fixture()).principal);
    await expectRefused({ ...caller, productId: "testapp" }, authorization);
  });

  test("a task run source is refused for a system account", async () => {
    const { caller, authorization } = persisted((await fixture()).principal);
    await expectRefused({ ...caller, principalKind: "system_account" }, authorization);
  });

  test("a task run source with a malformed or surplus field does not parse", () => {
    const source = {
      kind: "task_run",
      task_id: nextUuid(),
      task_run_id: nextUuid(),
      grant_id: null,
    };
    expect(ExecutionAuthorizationContextSchema.safeParse({ source }).success).toBe(true);
    for (const broken of [
      { ...source, task_id: "not-a-uuid" },
      { ...source, task_run_id: "not-a-uuid" },
      { ...source, grant_id: "not-a-uuid" },
      { ...source, access_token_id: nextUuid() },
      { kind: source.kind, task_id: source.task_id, task_run_id: source.task_run_id },
    ])
      expect(ExecutionAuthorizationContextSchema.safeParse({ source: broken }).success).toBe(false);
  });
});

describe("a task run caller is bound to the stored run", () => {
  test("a forged payload naming a run that does not exist is refused", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await expectRefused(caller, {
      ...authorization,
      source: { ...authorization.source, task_run_id: nextUuid() },
    });
  });

  test("a finished run is refused in every terminal state", async () => {
    for (const state of ["result_ready", "completed", "aborted", "failed"] as const) {
      const f = await fixture({ state });
      const { caller, authorization } = persisted(f.principal);
      await expectRefused(caller, authorization);
    }
  });

  test("a run that ended after the payload was captured is refused", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db
      .update(taskRuns)
      .set({ state: "completed" })
      .where(and(eq(taskRuns.tenant_id, ctx.tenantId), eq(taskRuns.id, f.task_run_id)));
    await expectRefused(caller, authorization);
  });

  test("a caller who does not own the task is refused", async () => {
    const f = await fixture();
    const stranger = await insertOwner();
    const { caller, authorization } = persisted(f.principal);
    await expectRefused({ ...caller, principalId: stranger.id }, authorization);
  });

  test("a task handed to another owner refuses the previous owner's payload", async () => {
    const f = await fixture();
    const next = await insertOwner();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db.update(tasks).set({ owner_id: next.id }).where(taskIs(f.task_id));
    await expectRefused(caller, authorization);
  });

  test("a payload naming another task than the run's is refused", async () => {
    const f = await fixture();
    const other = await insertTask(f.principal.id, {
      workflow_ids: f.workflow_ids,
      connector_ids: f.connector_ids,
    });
    const { caller, authorization } = persisted(f.principal);
    await expectRefused(caller, {
      ...authorization,
      source: { ...authorization.source, task_id: other },
    });
  });

  test("an archived task is refused", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db.update(tasks).set({ lifecycle: "archived" }).where(taskIs(f.task_id));
    await expectRefused(caller, authorization);
  });

  test("a paused task is refused", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db
      .update(tasks)
      .set({ paused_at: AT, paused_reason: "owner_request" })
      .where(taskIs(f.task_id));
    await expectRefused(caller, authorization);
  });

  test("a revoked grant is refused", async () => {
    const f = await fixture({ granted: true });
    const { caller, authorization } = persisted(f.principal);
    if (!f.grant_id) throw new Error("grant fixture missing");
    await ctx.testDb.db
      .update(taskGrants)
      .set({ revoked_at: AT, revoked_by: nextUuid() })
      .where(and(eq(taskGrants.tenant_id, ctx.tenantId), eq(taskGrants.id, f.grant_id)));
    await expectRefused(caller, authorization);
  });

  test("a revoked grant cannot be skipped by a payload that claims no grant", async () => {
    const f = await fixture({ granted: true });
    const { caller, authorization } = persisted(f.principal);
    if (!f.grant_id) throw new Error("grant fixture missing");
    await ctx.testDb.db
      .update(taskGrants)
      .set({ revoked_at: AT, revoked_by: nextUuid() })
      .where(and(eq(taskGrants.tenant_id, ctx.tenantId), eq(taskGrants.id, f.grant_id)));
    await expectRefused(caller, {
      ...authorization,
      source: { ...authorization.source, grant_id: null },
    });
  });

  test("a grant id the run does not carry is refused", async () => {
    const granted = await fixture({ granted: true });
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    await expectRefused(caller, {
      ...authorization,
      source: { ...authorization.source, grant_id: granted.grant_id },
    });
    await expectRefused(caller, {
      ...authorization,
      source: { ...authorization.source, grant_id: nextUuid() },
    });
  });

  test("a grant of another task is refused even when the run names it", async () => {
    const other = await fixture({ granted: true });
    const owner = await insertOwner();
    const task_id = await insertTask(owner.id, { workflow_ids: [], connector_ids: [] });
    const task_run_id = await insertRun(task_id, "running", other.grant_id);
    const { caller, authorization } = persisted({
      ...other.principal,
      id: owner.id,
      email: owner.email,
      allowed_workflows: [],
      allowed_connectors: [],
      auth_source: { kind: "task_run", task_id, task_run_id, grant_id: other.grant_id },
    });
    await expectRefused(caller, authorization);
  });

  test("a payload without both allow-lists is refused instead of restored unrestricted", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    const { allowed_workflows, allowed_connectors, ...bare } = authorization;
    await expectRefused(caller, bare);
    await expectRefused(caller, { ...bare, allowed_workflows });
    await expectRefused(caller, { ...bare, allowed_connectors });
    await expectRefused(caller, { ...authorization, allowed_workflows: "all" });
    await expectRefused(caller, { ...authorization, allowed_connectors: "all" });
  });

  test("captured allow-lists are narrowed to the task's current bindings", async () => {
    const f = await fixture();
    const [kept] = f.workflow_ids;
    if (!kept) throw new Error("workflow fixture missing");
    const { caller, authorization } = persisted(f.principal);
    await ctx.testDb.db
      .update(tasks)
      .set({
        bindings: {
          workflow_ids: [kept, nextUuid()],
          connector_ids: [],
          skill_slugs: [],
          web_search: false,
        },
      })
      .where(taskIs(f.task_id));
    const restored = await rehydrate(caller, authorization);
    expect(restored?.allowed_workflows).toEqual([kept]);
    expect(restored?.allowed_connectors).toEqual([]);
  });

  test("a forged payload cannot widen the allow-lists beyond the task's bindings", async () => {
    const f = await fixture();
    const { caller, authorization } = persisted(f.principal);
    const restored = await rehydrate(caller, {
      ...authorization,
      allowed_workflows: [...f.workflow_ids, nextUuid()],
      allowed_connectors: [nextUuid()],
    });
    expect(restored?.allowed_workflows).toEqual(f.workflow_ids);
    expect(restored?.allowed_connectors).toEqual([]);
  });

  test("a run of another tenant is refused", async () => {
    const foreign = await seedTenant(ctx.testDb.db, {
      slug: "et-authorization-task-run-foreign",
      display_name: "Foreign tenant",
    });
    const theirs = await fixture({ tenantId: foreign.id });
    const mine = await fixture();
    const { caller, authorization } = persisted(mine.principal);
    await expectRefused(caller, {
      ...authorization,
      source: {
        kind: "task_run",
        task_id: theirs.task_id,
        task_run_id: theirs.task_run_id,
        grant_id: null,
      },
    });
    const own = persisted(theirs.principal);
    expect((await rehydrate(own.caller, own.authorization))?.tenant_id).toBe(foreign.id);
    await expectRefused({ ...own.caller, tenantId: ctx.tenantId }, own.authorization);
  });
});
