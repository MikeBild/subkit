import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  sessions,
  taskGrants,
  tasks,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import {
  grantTaskAuthority,
  listTaskGrants,
  previewTaskGrant,
  revokeTaskAuthority,
} from "../grants.ts";
import {
  FINGERPRINT_A,
  FINGERPRINT_B,
  taskGrantFixtures,
  UNBOUND_STEP,
} from "./grants-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c0a);

let ctx: TestDb;

const f = taskGrantFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("task_grants");
});

afterAll(async () => {
  await ctx.cleanup();
});

type Person = Awaited<ReturnType<typeof f.person>>;

async function digests(task_id: string, person: Person) {
  const preview = await previewTaskGrant(task_id, person.context);
  return Object.fromEntries(
    preview.workflows.flatMap((workflow) =>
      workflow.effect_manifest_digest
        ? [[workflow.workflow_id, workflow.effect_manifest_digest]]
        : [],
    ),
  );
}

async function openEnded(task_id: string, person: Person) {
  return {
    expected_fingerprint: FINGERPRINT_A,
    valid_until: null,
    max_runs: null,
    expected_workflow_digests: await digests(task_id, person),
  };
}

function authoritiesOf(tenant_id: string) {
  return ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.tenant_id, tenant_id));
}

function auditOf(tenant_id: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, action)));
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
  const admin = await f.person(tenant.id, "admin");
  const eligible = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, owner.user.id, [eligible.id]);
  return { tenant, owner, admin, eligible, task };
}

test("the preview lists the schedule and the effect, eligibility and coverage of every bound workflow", async () => {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const eligible = await f.workflow(tenant.id);
  const unbound = await f.workflow(tenant.id, { step: UNBOUND_STEP });
  const sensitive = await f.workflow(tenant.id, { extra: { execution_privacy: "sensitive" } });
  const draft = await f.workflow(tenant.id, { lifecycle: "draft" });
  const missing = nextUuid();
  const task = await f.task(tenant.id, owner.user.id, [
    eligible.id,
    unbound.id,
    sensitive.id,
    draft.id,
    missing,
  ]);
  const preview = await previewTaskGrant(task.id, owner.context);
  expect(preview).toMatchObject({
    task_id: task.id,
    fingerprint: FINGERPRINT_A,
    environment: "dev",
    grantable: true,
    schedule: { schedule_cron: "0 9 * * *", schedule_timezone: "UTC", schedule_run_at: null },
    live_grant: null,
  });
  const byId = new Map(preview.workflows.map((workflow) => [workflow.workflow_id, workflow]));
  expect(byId.get(eligible.id)).toMatchObject({
    blocked_reason: null,
    workflow_version_id: eligible.version_id,
    covering_authority: null,
    may_grant: true,
  });
  expect(byId.get(eligible.id)?.effect_manifest?.effects.length).toBeGreaterThan(0);
  expect(byId.get(unbound.id)?.blocked_reason).toBe("workflow_not_repeatable");
  expect(byId.get(sensitive.id)?.blocked_reason).toBe("workflow_sensitive");
  expect(byId.get(draft.id)?.blocked_reason).toBe("workflow_not_active");
  expect(byId.get(missing)).toMatchObject({ blocked_reason: "workflow_missing", name: null });
});

test("a grant with a stale task fingerprint is refused and writes nothing", async () => {
  const s = await scenario();
  const input = await openEnded(s.task.id, s.owner);
  await ctx.db
    .update(tasks)
    .set({ fingerprint: FINGERPRINT_B })
    .where(and(eq(tasks.tenant_id, s.tenant.id), eq(tasks.id, s.task.id)));
  expect(await code(grantTaskAuthority(s.task.id, input, s.owner.context))).toBe(
    "task_fingerprint_changed",
  );
  expect(await listTaskGrants(s.task.id, s.owner.context)).toHaveLength(0);
  expect(await authoritiesOf(s.tenant.id)).toHaveLength(0);
});

test("API-key, MCP, cross-site, unproven and expired sessions are refused for grant and revoke", async () => {
  const s = await scenario();
  const input = await openEnded(s.task.id, s.admin);
  const { session_id: _session, ...withoutSession } = s.admin.principal;
  const apiKey = {
    ...s.admin.context,
    principal: { ...withoutSession, provider: "api_key", api_key_id: nextUuid() },
  };
  const mcp = {
    ...s.admin.context,
    principal: { ...withoutSession, provider: "mcp_oauth", oauth_client_id: "client" },
  };
  const headers = { cookie: s.admin.cookie, "x-subkit-csrf": s.admin.csrf };
  const crossSite = {
    ...s.admin.context,
    request: new Request("https://example.test/v1/tasks/grants", {
      method: "POST",
      headers: { ...headers, "sec-fetch-site": "cross-site" },
    }),
  };
  const noProof = {
    ...s.admin.context,
    request: new Request("https://example.test/v1/tasks/grants", {
      method: "POST",
      headers: { cookie: s.admin.cookie },
    }),
  };
  expect(await code(grantTaskAuthority(s.task.id, input, apiKey))).toBe("human_session_required");
  expect(await code(grantTaskAuthority(s.task.id, input, mcp))).toBe("human_session_required");
  expect(await code(grantTaskAuthority(s.task.id, input, crossSite))).toBe("csrf_rejected");
  expect(await code(grantTaskAuthority(s.task.id, input, noProof))).toBe("csrf_rejected");
  const granted = await grantTaskAuthority(s.task.id, input, s.admin.context);
  for (const context of [apiKey, mcp])
    expect(await code(revokeTaskAuthority(s.task.id, granted.grant.id, context))).toBe(
      "human_session_required",
    );
  expect(await code(revokeTaskAuthority(s.task.id, granted.grant.id, crossSite))).toBe(
    "csrf_rejected",
  );
  await ctx.db
    .update(sessions)
    .set({ revoked_at: await databaseNow(ctx.db) })
    .where(and(eq(sessions.tenant_id, s.tenant.id), eq(sessions.id, s.admin.session.id)));
  expect(await code(revokeTaskAuthority(s.task.id, granted.grant.id, s.admin.context))).toBe(
    "human_session_expired",
  );
  expect(
    await code(grantTaskAuthority(s.task.id, { ...input, max_runs: 2 }, s.admin.context)),
  ).toBe("human_session_expired");
  const [row] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, s.tenant.id), eq(taskGrants.id, granted.grant.id)));
  expect(row?.revoked_at).toBeNull();
});

test("another member is refused, the owner and an admin are accepted", async () => {
  const s = await scenario();
  const stranger = await f.person(s.tenant.id, "member");
  const input = await openEnded(s.task.id, s.owner);
  expect(await code(grantTaskAuthority(s.task.id, input, stranger.context))).toBe("task_not_found");
  expect(await code(previewTaskGrant(s.task.id, stranger.context))).toBe("task_not_found");
  const byOwner = await grantTaskAuthority(s.task.id, input, s.owner.context);
  expect(byOwner.grant.created_by).toBe(s.owner.user.id);
  expect(await code(revokeTaskAuthority(s.task.id, byOwner.grant.id, stranger.context))).toBe(
    "task_not_found",
  );
  const byAdmin = await grantTaskAuthority(s.task.id, input, s.admin.context);
  expect(byAdmin.changed).toBe(true);
  expect(byAdmin.grant.created_by).toBe(s.admin.user.id);
  const reader = await f.person(s.tenant.id, ["task:read", "workflow:write"]);
  const own = await f.task(s.tenant.id, reader.user.id, [s.eligible.id]);
  expect(
    await code(grantTaskAuthority(own.id, await openEnded(own.id, reader), reader.context)),
  ).toBe("task_grant_permission_denied");
});

test("the co-grant creates authorities only for eligible, uncovered workflows and audits every step", async () => {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const admin = await f.person(tenant.id, "admin");
  const eligible = await f.workflow(tenant.id);
  const covered = await f.workflow(tenant.id);
  const unbound = await f.workflow(tenant.id, { step: UNBOUND_STEP });
  const sensitive = await f.workflow(tenant.id, { extra: { execution_privacy: "sensitive" } });
  const task = await f.task(tenant.id, owner.user.id, [
    eligible.id,
    covered.id,
    unbound.id,
    sensitive.id,
  ]);
  const direct = await previewWorkflowAuthority(
    {
      tenant_id: tenant.id,
      workflow_id: covered.id,
      workflow_version_id: covered.version_id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const existing = await grantWorkflowAuthority(
    covered.id,
    {
      workflow_version_id: covered.version_id,
      expected_manifest_digest: direct.digest,
      execution_environment: "dev",
      valid_from: (await databaseNow(ctx.db)).toISOString(),
    },
    admin.context,
  );
  const preview = await previewTaskGrant(task.id, owner.context);
  expect(
    preview.workflows.find((workflow) => workflow.workflow_id === covered.id)?.covering_authority,
  ).toEqual({ id: existing.id, valid_until: null, remaining_runs: null });
  expect(preview.workflow_run_limit_shared_with_other_triggers).toBe(true);
  const until = new Date((await databaseNow(ctx.db)).getTime() + 7 * 86_400_000).toISOString();
  const result = await grantTaskAuthority(
    task.id,
    {
      expected_fingerprint: FINGERPRINT_A,
      valid_until: until,
      max_runs: 5,
      expected_workflow_digests: await digests(task.id, owner),
    },
    owner.context,
  );
  const outcome = new Map(result.workflows.map((workflow) => [workflow.workflow_id, workflow]));
  expect(outcome.get(eligible.id)).toMatchObject({ outcome: "granted", reason: null });
  expect(outcome.get(covered.id)).toMatchObject({ outcome: "covered", authority_id: existing.id });
  expect(outcome.get(unbound.id)).toMatchObject({
    outcome: "not_granted",
    authority_id: null,
    reason: "workflow_not_repeatable",
  });
  expect(outcome.get(sensitive.id)).toMatchObject({
    outcome: "not_granted",
    reason: "workflow_sensitive",
  });
  const created = outcome.get(eligible.id)?.authority_id;
  expect(result.grant.workflow_authority_ids).toEqual([created as string]);
  const rows = await authoritiesOf(tenant.id);
  expect(rows.map((row) => row.id).sort()).toEqual([existing.id, created as string].sort());
  const authority = rows.find((row) => row.id === created);
  expect(authority).toMatchObject({
    workflow_id: eligible.id,
    execution_environment: "dev",
    max_runs: 5,
    created_by: owner.user.id,
    revoked_at: null,
  });
  expect(authority?.valid_until?.toISOString()).toBe(until);
  expect(authority?.valid_from.toISOString()).toBe(result.grant.valid_from);
  const authorityAudit = (await auditOf(tenant.id, "workflow.authority_granted")).filter(
    (row) => row.resource_id === created,
  );
  expect(authorityAudit).toHaveLength(1);
  expect(authorityAudit[0]).toMatchObject({ actor_type: "user", actor_id: owner.user.id });
  expect(authorityAudit[0]?.metadata).toMatchObject({
    task_grant_id: result.grant.id,
    workflow_id: eligible.id,
    max_runs: 5,
    valid_until: until,
  });
  const [grantAudit] = await auditOf(tenant.id, "task.authority_granted");
  expect(grantAudit).toMatchObject({
    actor_type: "user",
    actor_id: owner.user.id,
    resource_type: "task_grant",
    resource_id: result.grant.id,
    result: "success",
  });
  expect(grantAudit?.metadata).toMatchObject({
    task_id: task.id,
    task_grant_id: result.grant.id,
    fingerprint: FINGERPRINT_A,
    execution_environment: "dev",
    valid_until: until,
    max_runs: 5,
    open_ended: false,
    workflow_authority_ids: [created],
    covered_workflow_ids: [covered.id],
  });
});

test("revoking a grant revokes only the authorities it created", async () => {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const first = await f.workflow(tenant.id);
  const second = await f.workflow(tenant.id);
  const taskA = await f.task(tenant.id, owner.user.id, [first.id]);
  const taskB = await f.task(tenant.id, owner.user.id, [first.id, second.id]);
  const a = await grantTaskAuthority(taskA.id, await openEnded(taskA.id, owner), owner.context);
  const b = await grantTaskAuthority(taskB.id, await openEnded(taskB.id, owner), owner.context);
  const [firstAuthority] = a.grant.workflow_authority_ids;
  const [secondAuthority] = b.grant.workflow_authority_ids;
  expect(a.grant.workflow_authority_ids).toHaveLength(1);
  expect(b.grant.workflow_authority_ids).toHaveLength(1);
  expect(b.workflows.find((workflow) => workflow.workflow_id === first.id)).toMatchObject({
    outcome: "covered",
    authority_id: firstAuthority,
  });
  const revocation = await revokeTaskAuthority(taskB.id, b.grant.id, owner.context);
  const revoked = revocation.grant;
  expect(revocation).toMatchObject({
    changed: true,
    revoked_workflow_authority_ids: [secondAuthority],
    transferred_workflow_authority_ids: [],
    retained_successor_authority_ids: [],
  });
  expect(revoked.revoked_by).toBe(owner.user.id);
  expect(revoked.revoked_at).not.toBeNull();
  const rows = new Map((await authoritiesOf(tenant.id)).map((row) => [row.id, row]));
  expect(rows.get(firstAuthority as string)?.revoked_at).toBeNull();
  expect(rows.get(secondAuthority as string)?.revoked_at).not.toBeNull();
  expect(rows.get(secondAuthority as string)?.revoked_by).toBe(owner.user.id);
  const [audit] = await auditOf(tenant.id, "task.authority_revoked");
  expect(audit).toMatchObject({
    actor_type: "user",
    actor_id: owner.user.id,
    resource_type: "task_grant",
    resource_id: b.grant.id,
  });
  expect(audit?.metadata).toMatchObject({
    task_id: taskB.id,
    reason_code: "revoked",
    revoked_workflow_authority_ids: [secondAuthority],
  });
  const authorityAudit = await auditOf(tenant.id, "workflow.authority_revoked");
  expect(authorityAudit).toHaveLength(1);
  expect(authorityAudit[0]).toMatchObject({
    actor_id: owner.user.id,
    resource_id: secondAuthority,
  });
  expect(authorityAudit[0]?.metadata).toMatchObject({
    task_grant_id: b.grant.id,
    reason_code: "revoked",
  });
  const again = await revokeTaskAuthority(taskB.id, b.grant.id, owner.context);
  expect(again.changed).toBe(false);
  expect(again.grant.revoked_at).toBe(revoked.revoked_at);
  expect(await auditOf(tenant.id, "task.authority_revoked")).toHaveLength(1);
  expect(await code(revokeTaskAuthority(taskA.id, b.grant.id, owner.context))).toBe(
    "task_grant_not_found",
  );
});
