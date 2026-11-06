import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  inspectInboundHookAutomation,
  inspectScheduleAutomation,
} from "../../scheduler/automation-status.ts";
import { grantWorkflowAuthority, previewWorkflowAuthority } from "../execution-authorities.ts";
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

for (const scenario of [
  "inactive",
  "different_environment",
  "future",
  "exhausted",
  "missing_input",
] as const) {
  test(`a ${scenario} authority does not resolve a held schedule`, async () => {
    const f = await fixture(
      scenario === "missing_input"
        ? {
            input_schema: {
              type: "object",
              required: ["report"],
              properties: { report: { type: "string" } },
            },
          }
        : {},
    );
    if (scenario !== "inactive")
      await ctx.db
        .update(workflows)
        .set({ lifecycle: "active", current_version_id: f.version.id })
        .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
    const hold = {
      reason_code: "execution_authority_unavailable" as const,
      observed_at: f.input.valid_from,
    };
    const [schedule] = await ctx.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: f.workflow.tenant_id,
        workflow_id: f.workflow.id,
        cron: "0 9 * * *",
        timezone: "UTC",
        execution_mode: scenario === "different_environment" ? "prod" : "dev",
        input: { business_days_only: false, skip_dates: [] },
        admission_hold: hold,
      })
      .returning();
    if (!schedule) throw new Error("missing schedule");
    const input =
      scenario === "future"
        ? {
            ...f.input,
            valid_from: new Date(Date.parse(f.input.valid_from) + 60_000).toISOString(),
          }
        : f.input;
    const authority = await grantWorkflowAuthority(f.workflow.id, input, f.context);
    if (scenario === "exhausted") {
      await ctx.db
        .update(workflowExecutionAuthorities)
        .set({ reserved_runs: authority.max_runs ?? 0 })
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id),
            eq(workflowExecutionAuthorities.id, authority.id),
          ),
        );
      await ctx.db
        .update(workflowsSchedules)
        .set({ admission_hold: hold })
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            eq(workflowsSchedules.id, schedule.id),
          ),
        );
      await grantWorkflowAuthority(f.workflow.id, input, f.context);
    }
    const [observed] = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
          eq(workflowsSchedules.id, schedule.id),
        ),
      );
    expect(observed?.admission_hold).toEqual(hold);
    expect((await inspectScheduleAutomation(schedule, ctx.db)).ready).toBe(false);
  });
}

test("a production grant releases the workflow's held inbound hook, and nothing else", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const hold = {
    reason_code: "execution_authority_unavailable" as const,
    observed_at: f.input.valid_from,
  };
  const secret = { secret_ciphertext: Buffer.alloc(1), secret_iv: Buffer.alloc(1) };
  const [hook] = await ctx.db
    .insert(webhooksInbound)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      slug: `${f.workflow.slug}-hook`,
      verifier: "standard",
      ...secret,
      secret_auth_tag: Buffer.alloc(1),
      admission_hold: hold,
    })
    .returning();
  const [other] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: f.workflow.tenant_id,
      slug: `${f.workflow.slug}-other`,
      name: "Other",
      lifecycle: "draft",
    })
    .returning();
  if (!hook || !other) throw new Error("missing hook fixture");
  await ctx.db.insert(webhooksInbound).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: other.id,
    slug: `${f.workflow.slug}-other-hook`,
    verifier: "standard",
    ...secret,
    secret_auth_tag: Buffer.alloc(1),
    admission_hold: hold,
  });
  expect((await inspectInboundHookAutomation(hook, ctx.db)).state).toBe("approval_required");
  const held = async () =>
    (
      await ctx.db
        .select({ workflow_id: webhooksInbound.workflow_id })
        .from(webhooksInbound)
        .where(
          and(
            eq(webhooksInbound.tenant_id, f.workflow.tenant_id),
            sql`${webhooksInbound.admission_hold} IS NOT NULL`,
          ),
        )
    ).map((row) => row.workflow_id);

  await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  expect((await held()).sort()).toEqual([f.workflow.id, other.id].sort());

  const prod = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "prod",
    },
    ctx.db,
  );
  await grantWorkflowAuthority(
    f.workflow.id,
    { ...f.input, execution_environment: "prod", expected_manifest_digest: prod.digest },
    f.context,
  );
  expect(await held()).toEqual([other.id]);
  expect((await inspectInboundHookAutomation(hook, ctx.db)).state).toBe("authorized");
});

test("a refusal racing a production grant cannot leave a hold behind it", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const [hook] = await ctx.db
    .insert(webhooksInbound)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      slug: `${f.workflow.slug}-hook`,
      verifier: "standard",
      secret_ciphertext: Buffer.alloc(1),
      secret_iv: Buffer.alloc(1),
      secret_auth_tag: Buffer.alloc(1),
    })
    .returning();
  if (!hook) throw new Error("missing hook fixture");
  const prod = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "prod",
    },
    ctx.db,
  );
  const hold = {
    reason_code: "execution_authority_required" as const,
    observed_at: f.input.valid_from,
  };
  let grant: Promise<unknown> = Promise.resolve();
  await ctx.db.transaction(async (refusal) => {
    await refusal
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(eq(webhooksInbound.id, hook.id))
      .for("update");
    let granted = false;
    grant = grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, execution_environment: "prod", expected_manifest_digest: prod.digest },
      f.context,
    ).finally(() => {
      granted = true;
    });
    for (let attempt = 0; attempt < 200 && !granted; attempt += 1) {
      const waiting = await ctx.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%webhooks_inbound%'`,
      );
      if ((waiting.rows[0]?.n ?? 0) > 0) break;
      await Bun.sleep(25);
    }
    await refusal
      .update(webhooksInbound)
      .set({ admission_hold: hold })
      .where(eq(webhooksInbound.id, hook.id));
  });
  await grant;
  const [observed] = await ctx.db
    .select({ admission_hold: webhooksInbound.admission_hold })
    .from(webhooksInbound)
    .where(eq(webhooksInbound.id, hook.id));
  expect(observed?.admission_hold).toBeNull();
});

test("automation evidence rejects expired, changed-version and cross-tenant grants", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const [schedule] = await ctx.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      cron: "0 9 * * *",
      timezone: "UTC",
      execution_mode: "dev",
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const now = Date.parse(f.input.valid_from);
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
    effect_manifest_digest: preview.digest,
    effect_manifest: preview.manifest,
    execution_environment: "dev",
    target_constraints: { targets: [] },
    valid_from: new Date(now - 7200000),
    valid_until: new Date(now - 3600000),
    max_runs: 1,
    created_by: f.context.principal.id,
  });
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const [v2] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: f.version.dag,
    })
    .returning();
  if (!v2) throw new Error("missing version");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: v2.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  expect(
    (
      await inspectScheduleAutomation(
        { ...schedule, tenant_id: "00000000-0000-4000-8000-000000000099" },
        ctx.db,
      )
    ).ready,
  ).toBe(false);
});
