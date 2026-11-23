import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  auditLog,
  events,
  sessions,
  users,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { grantWorkflowAuthority, revokeWorkflowAuthority } from "../execution-authorities.ts";
import { executionAuthoritiesFixtures } from "./execution-authorities-fixtures.ts";

let ctx: TestDb;

const { fixture } = executionAuthoritiesFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_grant");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("a human grants a boundary until revoked; a lost response does not grant twice", async () => {
  const f = await fixture();
  const { valid_until: _until, max_runs: _runs, ...openEnded } = f.input;
  const authority = await grantWorkflowAuthority(f.workflow.id, openEnded, f.context);
  expect(authority).toMatchObject({ valid_until: null, max_runs: null, reserved_runs: 0 });
  expect(authority.approved_manifest).toEqual(authority.effect_manifest);
  const retry = await grantWorkflowAuthority(
    f.workflow.id,
    { ...openEnded, valid_until: null, max_runs: null },
    f.context,
  );
  expect(retry.id).toBe(authority.id);
  await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
  await expect(grantWorkflowAuthority(f.workflow.id, openEnded, f.context)).rejects.toMatchObject({
    code: "authority_revoked",
  });
  const changes = await ctx.db
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.tenant_id, f.workflow.tenant_id),
        eq(events.channel, "resource.lifecycle"),
        sql`${events.payload}->>'workflow_id' = ${f.workflow.id}`,
      ),
    )
    .orderBy(events.id);
  expect(changes).toEqual([
    {
      type: "workflow.authority_granted",
      payload: {
        workflow_id: f.workflow.id,
        workflow_version_id: authority.workflow_version_id,
        authority_id: authority.id,
      },
    },
    {
      type: "workflow.authority_revoked",
      payload: { workflow_id: f.workflow.id, authority_id: authority.id },
    },
  ]);
});

test("a human grants a finite exact boundary without activating or running its draft", async () => {
  const f = await fixture();
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  expect(authority).toMatchObject({
    effect_manifest_digest: f.input.expected_manifest_digest,
    workflow_version_id: f.version.id,
    reserved_runs: 0,
    max_runs: 3,
    target_constraints: { targets: ["https://example.test/messages"] },
    created_by: f.context.principal.id,
  });
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, f.workflow.id));
  expect(workflow?.lifecycle).toBe("draft");
  expect(workflow?.current_version_id).toBeNull();
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.workflow.tenant_id), eq(auditLog.resource_id, authority.id)),
    );
  expect(audit.map((row) => row.action)).toEqual(["workflow.authority_granted"]);
});

test("parallel retries return one authority and never multiply the run allowance", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    grantWorkflowAuthority(f.workflow.id, f.input, f.context),
    grantWorkflowAuthority(f.workflow.id, f.input, f.context),
  ]);
  expect(a.id).toBe(b.id);
  const rows = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id));
  expect(rows).toHaveLength(1);
});

test("API-key-style callers and missing or cross-site CSRF proofs cannot grant", async () => {
  const f = await fixture();
  const noSession = { ...f.context.principal };
  delete noSession.session_id;
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, { ...f.context, principal: noSession }),
  ).rejects.toMatchObject({ code: "human_session_required" });
  for (const headers of [
    new Headers({ cookie: f.context.request.headers.get("cookie")! }),
    new Headers(f.context.request.headers),
  ]) {
    if (headers.has("x-subkit-csrf")) headers.set("sec-fetch-site", "cross-site");
    await expect(
      grantWorkflowAuthority(f.workflow.id, f.input, {
        ...f.context,
        request: new Request(f.context.request.url, { method: "POST", headers }),
      }),
    ).rejects.toMatchObject({ code: "csrf_rejected" });
  }
});

test("signed but revoked sessions cannot grant", async () => {
  const f = await fixture();
  await ctx.db
    .update(sessions)
    .set({ revoked_at: await databaseNow(ctx.db) })
    .where(eq(sessions.id, f.session.id));
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "human_session_expired",
  });
});

test("a user without workflow permission cannot grant", async () => {
  const f = await fixture();
  await ctx.db
    .update(users)
    .set({ role_id: await emptyRoleId(ctx.db, f.workflow.tenant_id) })
    .where(eq(users.id, f.context.principal.id));
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, {
      ...f.context,
      principal: { ...f.context.principal, roles: [] },
    }),
  ).rejects.toMatchObject({ code: "authority_permission_denied" });
});

test("stale manifests and invalid finite windows are rejected", async () => {
  const f = await fixture();
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, expected_manifest_digest: "0".repeat(64) },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_manifest_changed" });
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, valid_until: f.input.valid_from },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_window_invalid" });
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      {
        ...f.input,
        valid_until: new Date(
          new Date(f.input.valid_from).getTime() + 32 * 24 * 60 * 60_000,
        ).toISOString(),
      },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_window_invalid" });
});

test("revocation is idempotent and an old browser retry cannot resurrect it", async () => {
  const f = await fixture();
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const revoked = await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
  expect(revoked.revoked_at).not.toBeNull();
  expect(await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context)).toEqual(revoked);
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "authority_revoked",
  });
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.workflow.tenant_id), eq(auditLog.resource_id, authority.id)),
    );
  expect(audit.map((row) => row.action).sort()).toEqual([
    "workflow.authority_granted",
    "workflow.authority_revoked",
  ]);
});

test("audit failure rolls the grant back", async () => {
  const f = await fixture();
  await ctx.db.execute(
    sql.raw(`CREATE FUNCTION subkit.reject_authority_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'workflow.authority_granted' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_authority_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.reject_authority_audit()`),
  );
  try {
    await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toThrow();
    expect(
      await ctx.db
        .select()
        .from(workflowExecutionAuthorities)
        .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id)),
    ).toHaveLength(0);
  } finally {
    await ctx.db.execute(
      sql.raw(
        "DROP TRIGGER reject_authority_audit ON subkit.audit_log; DROP FUNCTION subkit.reject_authority_audit()",
      ),
    );
  }
});

test("reviewed active authority resolves exactly its held schedule, audited and retry-safe", async () => {
  const f = await fixture({
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  });
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const hold = {
    reason_code: "execution_authority_expired" as const,
    observed_at: f.input.valid_from,
  };
  const [schedule] = await ctx.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      cron: "0 9 * * *",
      timezone: "UTC",
      execution_mode: "dev",
      admission_hold: hold,
      input: { business_days_only: false, skip_dates: [] },
      created_at: new Date(new Date(f.input.valid_from).getTime() - 2 * 86_400_000),
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  const [other] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: f.workflow.tenant_id,
      slug: "unrelated-hold",
      name: "Other report",
      lifecycle: "draft",
    })
    .returning();
  if (!other) throw new Error("missing unrelated workflow");
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: other.id,
    cron: "0 10 * * *",
    execution_mode: "dev",
    admission_hold: hold,
  });
  const countOpen = async () =>
    (
      await ctx.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            sql`${workflowsSchedules.admission_hold} IS NOT NULL`,
          ),
        )
    ).length;
  expect(await countOpen()).toBe(2);
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const read = async () =>
    (
      await ctx.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            eq(workflowsSchedules.id, schedule.id),
          ),
        )
    )[0];
  expect((await read())?.admission_hold).toBeNull();
  expect(await countOpen()).toBe(1);
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("authorized");
  const stamped = (await read())?.last_enqueued_at;
  expect(stamped).toBeInstanceOf(Date);
  const sent: unknown[] = [];
  const reconciler = new SchedulerReconciler({
    boss: {
      send: async (_queue: string, payload: unknown) => {
        sent.push(payload);
        return "job";
      },
    } as unknown as PgBoss,
    db: ctx.db,
  });
  const approvedAt = stamped as Date;
  await reconciler.reconcileWorkflowSchedules(new Date(approvedAt.getTime() + 60_000));
  expect(sent).toHaveLength(0);
  const nextOccurrence = new Date(approvedAt);
  nextOccurrence.setUTCDate(nextOccurrence.getUTCDate() + 1);
  nextOccurrence.setUTCHours(9, 1, 0, 0);
  await reconciler.reconcileWorkflowSchedules(nextOccurrence);
  expect(sent).toHaveLength(1);
  await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.workflow.tenant_id),
        eq(auditLog.resource_id, schedule.id),
        eq(auditLog.action, "schedule.admission.changed"),
      ),
    );
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toMatchObject({
    state: "authorized",
    execution_authority_id: authority.id,
  });
  await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
  expect((await inspectScheduleAutomation(schedule, ctx.db)).ready).toBe(false);
});
