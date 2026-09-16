import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  executionSteps,
  sessions,
  users,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { prepareReportAuthority } from "../../workflows/prepare-report-authority.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let sequence = 0;
beforeAll(async () => {
  ctx = await createEngineCtx("report-authority");
});
afterAll(async () => {
  await ctx.cleanup();
});
async function fixture(withRead = false) {
  const raw = Buffer.from(
    "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\nReport",
  ).toString("base64url");
  const wf = await createWorkflowRow(ctx, {
    name: "Daily report",
    slug: `report-${++sequence}`,
    steps: [
      ...(withRead
        ? [
            {
              id: "read",
              kind: "request" as const,
              method: "GET" as const,
              url: "https://metrics.example.test/history",
              query: {
                host_id: "fixed-resource",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow query substitution
                end: "${input.window}",
              },
              max_retries: 0,
            },
          ]
        : []),
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: GMAIL_SEND_TARGET,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { raw: "${input.raw}" },
        max_retries: 0,
      },
    ],
  });
  const db = ctx.testDb.db;
  const now = await databaseNow(db);
  const [user] = await db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: `human-${sequence}@example.test`, role: "admin" })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3600000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    session_id: session.id,
  };
  const request = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
  const [schedule] = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.workflow_id,
      cron: "0 7 * * *",
      execution_mode: "dev",
      input: { raw, window: raw.length },
      admission_hold: {
        reason_code: "execution_authority_unavailable",
        observed_at: now.toISOString(),
      },
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  const inspect = () =>
    previewWorkflowAuthority(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        workflow_version_id: wf.version_id,
        execution_environment: "dev",
      },
      db,
    );
  const prepare = async (value = raw) =>
    runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id: wf.workflow_id },
      input: { raw: value, window: value.length },
      options: { hold_writes: true, execution_mode: "dev", principal },
    });
  const grant = async () => {
    const preview = await inspect();
    return grantWorkflowAuthority(
      wf.workflow_id,
      {
        workflow_version_id: wf.version_id,
        expected_manifest_digest: preview.digest,
        execution_environment: "dev",
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3600000).toISOString(),
        max_runs: 2,
      },
      { db, request, principal },
    );
  };
  const run = async (value = raw) => {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        execution_environment: "dev",
        request_source: "scheduler",
        input: { raw: value, window: value.length },
      },
      db,
    );
    return runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id: wf.workflow_id },
      input: { raw: value, window: value.length },
      options: { existing_execution_id: admitted.execution_id, principal },
    });
  };
  const automaticPrepare = () =>
    prepareReportAuthority(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        workflow_version_id: wf.version_id,
        execution_environment: "dev",
      },
      db,
      principal,
    );
  return { raw, wf, schedule, inspect, prepare, automaticPrepare, grant, run };
}

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
  await withDriverFetchForTests(remote, async () => {
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
    // Retention of preview traces must not remove an existing human boundary.
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
  await withDriverFetchForTests(remote, async () => {
    const changed = Buffer.from(
      Buffer.from(f.raw, "base64url")
        .toString()
        .replace("recipient@example.test", "other@example.test"),
    ).toString("base64url");
    const result = await f.run(changed);
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error).toMatchObject({ code: "authority_invalid" });
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
