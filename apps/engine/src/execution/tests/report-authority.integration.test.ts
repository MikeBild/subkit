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
  workflows,
  workflowsSchedules,
  workflowVersions,
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
async function fixture(withRead: boolean | "path" = false) {
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
              url:
                withRead === "path"
                  ? // biome-ignore lint/suspicious/noTemplateCurlyInString: bounded identifier
                    "https://metrics.example.test/v2/projects/${input.window}/resources"
                  : "https://metrics.example.test/history",
              query:
                withRead === "path"
                  ? undefined
                  : {
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
  const run = async (value = raw, resource: string | number = value.length) => {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: wf.workflow_id,
        execution_environment: "dev",
        request_source: "scheduler",
        input: { raw: value, window: resource },
      },
      db,
    );
    return runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id: wf.workflow_id },
      input: { raw: value, window: resource },
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
  return {
    raw,
    wf,
    schedule,
    inspect,
    prepare,
    automaticPrepare,
    grant,
    run,
    principal,
    request,
    now,
  };
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
  await withDriverFetchForTests(remote, async () => {
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
