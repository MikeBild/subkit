import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  executionSteps,
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { carryApprovalsForward } from "../../workflows/authority-inheritance.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { prepareReportAuthority } from "../../workflows/prepare-report-authority.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { reportAuthorityFixtures } from "./report-authority-fixtures.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

const { fixture } = reportAuthorityFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createEngineCtx("report-authority");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("preview -> human recurring grant -> schedule resolved -> two changing reports without another approval", async () => {
  const f = await fixture(true);
  let sends = 0;
  const remote = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(new URL(String(url)).searchParams.get("host_id")).toBe("fixed-resource");
        return Response.json({ observations: [] });
      }
      sends++;
      return Response.json({ id: `sent-${sends}` });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(false);
    await f.automaticPrepare();
    expect(sends).toBe(0);
    const preview = await f.inspect();
    expect(preview.eligible_for_repeated_runs).toBe(true);
    expect(
      preview.manifest.effects.find((effect) => effect.step_id === "send")?.report_delivery?.to,
    ).toBe("recipient@example.test");
    await f.grant();
    const [schedule] = await ctx.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.tenantId),
          eq(workflowsSchedules.id, f.schedule.id),
        ),
      );
    expect(schedule?.admission_hold).toBeNull();
    expect((await inspectScheduleAutomation(schedule!, ctx.testDb.db)).ready).toBe(true);
    await ctx.testDb.db.delete(executionSteps).where(eq(executionSteps.tenant_id, ctx.tenantId));
    expect((await f.run()).status).toBe("succeeded");
    const next = Buffer.from(
      Buffer.from(f.raw, "base64url")
        .toString()
        .replace(/Report/g, "New report"),
    ).toString("base64url");
    expect((await f.run(next)).status).toBe("succeeded");
    expect(sends).toBe(2);
    await expect(f.run()).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  });
});

test("a report approval follows an activated version that reaches nothing new, and sends", async () => {
  const f = await fixture();
  let sends = 0;
  const remote = Object.assign(
    async () => {
      sends++;
      return Response.json({ id: `sent-${sends}` });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    await f.automaticPrepare();
    const granted = await f.grant();
    const db = ctx.testDb.db;
    const [current] = await db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, f.wf.version_id));
    const [next] = await db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: f.wf.workflow_id,
        version: 2,
        dag: { ...(current?.dag as Record<string, unknown>), description: "Daily report, v2" },
      })
      .returning();
    if (!next) throw new Error("missing v2");
    const outcome = await db.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({ current_version_id: next.id })
        .where(eq(workflows.id, f.wf.workflow_id));
      return carryApprovalsForward(tx, {
        tenant_id: ctx.tenantId,
        workflow_id: f.wf.workflow_id,
        from_version_id: f.wf.version_id,
        to_version_id: next.id,
        actor_id: f.principal.id,
      });
    });
    expect(outcome.inherited).toHaveLength(1);
    const [child] = await db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.inherited_from, granted.id));
    expect(child?.workflow_version_id).toBe(next.id);
    expect((await f.run()).status).toBe("succeeded");
    expect(sends).toBe(1);
  });
});

test("a changed recipient is rejected before egress even with a live recurring authority", async () => {
  const f = await fixture();
  await f.prepare();
  await f.grant();
  let sends = 0;
  const remote = Object.assign(
    async () => {
      sends++;
      return Response.json({ id: "unexpected" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    const changed = Buffer.from(
      Buffer.from(f.raw, "base64url")
        .toString()
        .replace("recipient@example.test", "other@example.test"),
    ).toString("base64url");
    const result = await f.run(changed);
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error).toMatchObject({ code: "execution_authority_changed" });
    expect(sends).toBe(0);
  });
});

for (const state of ["revoked", "expired"] as const) {
  test(`${state} report permission blocks dispatch and readiness`, async () => {
    const f = await fixture();
    await f.automaticPrepare();
    const grant = await f.grant();
    const now = await databaseNow(ctx.testDb.db);
    const [stored] = await ctx.testDb.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.id, grant.id));
    if (!stored) throw new Error("missing authority");
    await ctx.testDb.db
      .update(workflowExecutionAuthorities)
      .set({ revoked_at: now, revoked_by: stored.created_by })
      .where(eq(workflowExecutionAuthorities.id, grant.id));
    if (state === "expired") {
      const { id: _id, ...copy } = stored;
      await ctx.testDb.db.insert(workflowExecutionAuthorities).values({
        ...copy,
        valid_from: new Date(now.getTime() - 7200000),
        valid_until: new Date(now.getTime() - 3600000),
      });
    }
    expect((await inspectScheduleAutomation(f.schedule, ctx.testDb.db)).ready).toBe(false);
    await expect(f.run()).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  });
}

test("preview cannot borrow a report recipient from another environment or tenant", async () => {
  const f = await fixture();
  await f.automaticPrepare();
  const input = {
    tenant_id: ctx.tenantId,
    workflow_id: f.wf.workflow_id,
    workflow_version_id: f.wf.version_id,
    execution_environment: "prod" as const,
  };
  expect((await previewWorkflowAuthority(input, ctx.testDb.db)).eligible_for_repeated_runs).toBe(
    false,
  );
  await expect(
    previewWorkflowAuthority({ ...input, tenant_id: f.wf.workflow_id }, ctx.testDb.db),
  ).rejects.toMatchObject({ code: "workflow_version_unavailable" });
});

test("a reviewed report draft is activated and resolves only its own held decision atomically", async () => {
  const f = await fixture();
  const other = await fixture();
  const db = ctx.testDb.db;
  const [original] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.wf.version_id));
  if (!original) throw new Error("missing version");
  const [draft] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      version: 2,
      dag: original.dag,
    })
    .returning();
  if (!draft) throw new Error("missing draft");
  await db
    .update(workflows)
    .set({ draft_version_id: draft.id })
    .where(eq(workflows.id, f.wf.workflow_id));
  const reviewInput = {
    tenant_id: ctx.tenantId,
    workflow_id: f.wf.workflow_id,
    workflow_version_id: draft.id,
    execution_environment: "dev" as const,
  };
  await prepareReportAuthority(reviewInput, db, f.principal);
  const [preparedCaller] = await db
    .select({ caller: executions.caller_context })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_version_id, draft.id),
        eq(executions.hold_writes, true),
      ),
    );
  expect(preparedCaller?.caller).toMatchObject({
    principalId: f.principal.id,
    principalKind: f.principal.kind,
    tenantId: ctx.tenantId,
  });

  const preview = await previewWorkflowAuthority(reviewInput, db);
  expect(preview.eligible_for_repeated_runs).toBe(true);
  await grantWorkflowAuthority(
    f.wf.workflow_id,
    {
      workflow_version_id: draft.id,
      execution_environment: "dev",
      expected_manifest_digest: preview.digest,
      valid_from: f.now.toISOString(),
      valid_until: new Date(f.now.getTime() + 3600000).toISOString(),
      max_runs: 2,
      activation: { expected_current_version_id: f.wf.version_id },
    },
    { db, principal: f.principal, request: f.request },
  );
  const [current] = await db.select().from(workflows).where(eq(workflows.id, f.wf.workflow_id));
  expect(current?.current_version_id).toBe(draft.id);
  expect(current?.draft_version_id).toBeNull();
  const held = await db
    .select()
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.tenant_id, ctx.tenantId));
  const resolved = held.find((row) => row.id === f.schedule.id)!;
  expect(resolved.admission_hold).toBeNull();
  expect(held.find((row) => row.id === other.schedule.id)?.admission_hold).not.toBeNull();
  expect((await inspectScheduleAutomation(resolved, db)).ready).toBe(true);
});

test("reviewed identifier path permits changing project reads and blocks path escape before dispatch", async () => {
  const f = await fixture("path");
  let reads = 0;
  let sends = 0;
  const remote = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        reads++;
        return Response.json({ resources: [] });
      }
      sends++;
      return Response.json({ id: "sent" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    await f.prepare();
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(true);
    await f.grant();
    const good = await f.run(f.raw, "project-123");
    expect(good.status).toBe("succeeded");
    const before = reads;
    const bad = await f.run(f.raw, "../../secrets");
    expect(bad.status).toBe("failed");
    expect(reads).toBe(before);
    expect(sends).toBe(1);
  });
});

test("documented Analytics report reads execute in preview while email remains held", async () => {
  const f = await fixture("analytics");
  let reads = 0;
  const remote = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      reads++;
      return Response.json({ rows: [] });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    await f.automaticPrepare();
    expect(reads).toBe(1);
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(true);
    expect((await inspectScheduleAutomation(f.schedule, ctx.testDb.db)).ready).toBe(false);
  });
});

test("documented Analytics report reads execute in preview through a connector bound to a tenant template", async () => {
  const f = await fixture("analytics-tenant");
  let reads = 0;
  const remote = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
      );
      expect(init?.method).toBe("POST");
      reads++;
      return Response.json({ rows: [] });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    await f.automaticPrepare();
    expect(reads).toBe(1);
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(true);
  });
});

test("documented report reads cannot delegate preview permission through a redirect", async () => {
  const f = await fixture("analytics");
  let requests = 0;
  const remote = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests++;
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { location: "https://other.example.test/write" },
      });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withSelfHostedDriverFetchForTests(remote, async () => {
    await expect(f.automaticPrepare()).rejects.toMatchObject({
      code: "authority_preparation_failed",
    });
    expect(requests).toBe(1);
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(false);
  });
});

test("the report refusal says which of three situations this is", async () => {
  const f = await fixture();
  const reasonFor = async () =>
    (await f.inspect()).request_refusals.find((entry) => entry.step_id === "send")?.reason;

  expect(await reasonFor()).toBe("report_delivery_unprepared");

  const db = ctx.testDb.db;
  const [stranded] = await db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      workflow_version_id: f.wf.version_id,
      source_kind: "saved",
      status: "failed",
      request_source: "api",
      execution_mode: "dev",
      hold_writes: true,
    })
    .returning();
  await db.insert(executionSteps).values({
    tenant_id: ctx.tenantId,
    execution_id: stranded?.id as string,
    step_key: "some_earlier_step",
    step_index: 0,
    kind: "request",
    status: "succeeded",
    request_meta: { driver: "http", url: "https://metrics.example.test/history" },
  });
  expect(await reasonFor()).toBe("report_delivery_unreachable");

  await db.insert(executionSteps).values({
    tenant_id: ctx.tenantId,
    execution_id: stranded?.id as string,
    step_key: "send",
    step_index: 1,
    kind: "request",
    status: "succeeded",
    request_meta: { driver: "http", url: GMAIL_SEND_TARGET, extras: { held: true } },
  });
  expect(await reasonFor()).toBe("report_delivery_unobserved");
});
