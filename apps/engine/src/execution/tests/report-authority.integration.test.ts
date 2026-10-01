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
  executions,
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
async function fixture(withRead: boolean | "path" | "analytics" = false) {
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
              method: withRead === "analytics" ? ("POST" as const) : ("GET" as const),
              body:
                withRead === "analytics"
                  ? {
                      dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
                      metrics: [{ name: "activeUsers" }],
                    }
                  : undefined,
              url:
                withRead === "analytics"
                  ? "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport"
                  : withRead === "path"
                    ? // biome-ignore lint/suspicious/noTemplateCurlyInString: bounded identifier
                      "https://metrics.example.test/v2/projects/${input.window}/resources"
                    : "https://metrics.example.test/history",
              query:
                withRead === "path" || withRead === "analytics"
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
  await withDriverFetchForTests(remote, async () => {
    await f.automaticPrepare();
    expect(reads).toBe(1);
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(true);
    expect((await inspectScheduleAutomation(f.schedule, ctx.testDb.db)).ready).toBe(false);
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
  await withDriverFetchForTests(remote, async () => {
    await expect(f.automaticPrepare()).rejects.toMatchObject({
      code: "authority_preparation_failed",
    });
    expect(requests).toBe(1);
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(false);
  });
});

test("the report refusal says which of three situations this is", async () => {
  // One code answered all three, and its remedy — "let a preparation run" — is
  // the right advice for two of them and a circle for the third. On production
  // `radar-collect-weekly` sat in that third state: a preparation run existed,
  // its email step sits behind a branch whose condition depends on a write the
  // preparation holds back, so no preparation can ever observe it. The dialog
  // kept telling a person to do the one thing that cannot work.
  const f = await fixture();
  const reasonFor = async () =>
    (await f.inspect()).request_refusals.find((entry) => entry.step_id === "send")?.reason;

  // Nothing has watched this step yet.
  expect(await reasonFor()).toBe("report_delivery_unprepared");

  // A preparation run that never reaches the step: the run exists, the step
  // does not appear in it. Seeded directly, because producing the real
  // unreachable shape needs a branch on a held write — which is exactly the
  // situation that cannot be produced by running one.
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
  // And the run is read at all despite having failed — the evidence is per
  // step, so requiring the whole run to succeed threw away the only evidence a
  // partially-reaching run ever leaves.

  // The step ran and was held, but recorded nothing the profile can read.
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

test("a report step the profile has already bounded reports no refusal at all", async () => {
  // Every healthy Gmail report step carried `stricter_profile_applies` on every
  // preview — a refusal beside a boundary that exists, on a step with nothing
  // wrong with it. Noise that buries the steps a person has to act on.
  const f = await fixture();
  await f.prepare();
  const preview = await f.inspect();
  expect(
    preview.manifest.effects.find((effect) => effect.step_id === "send")?.report_delivery?.to,
  ).toBe("recipient@example.test");
  expect(preview.request_refusals.find((entry) => entry.step_id === "send")).toBeUndefined();
});

test("a preparation that is already running is refused with a reason, not started twice", async () => {
  // The dialog showed a bare "loading" for as long as a held run takes, so
  // people opened a second tab — and three held runs started against the same
  // workflow, each reading the same remote systems and each overwriting the
  // evidence the others left. A flag inside the component cannot see a second
  // tab. This can, and it sees a second engine process too.
  //
  // Seeded rather than raced: two concurrent calls only reach the lock when
  // they interleave a particular way, and a test that asserts on an
  // interleaving asserts on the machine it runs on. The state under test is
  // "a held run for this version is already going", so that is what is set up.
  const f = await fixture();
  const db = ctx.testDb.db;
  await db.insert(executions).values({
    tenant_id: ctx.tenantId,
    workflow_id: f.wf.workflow_id,
    workflow_version_id: f.wf.version_id,
    source_kind: "saved",
    status: "running",
    request_source: "ui",
    execution_mode: "dev",
    hold_writes: true,
  });
  const outcome = await prepareReportAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      workflow_version_id: f.wf.version_id,
      execution_environment: "dev",
    },
    db,
    f.principal,
  );
  // A reason, not an error: two tabs on one dialog is ordinary, and a repair
  // reload takes this path routinely.
  expect(outcome).toEqual({ prepared: false, reason: "preparation_in_flight" });
  const runs = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_id, f.wf.workflow_id),
        eq(executions.hold_writes, true),
      ),
    );
  expect(runs).toHaveLength(1);
});

test("two preparations at once still produce one held run", async () => {
  // The concurrent case, asserting only what does not depend on interleaving:
  // however the two calls arrive, the workflow ends up with one held run and
  // not two. Which of them is refused, and on which of the two checks, is the
  // machine's business.
  const f = await fixture();
  const input = {
    tenant_id: ctx.tenantId,
    workflow_id: f.wf.workflow_id,
    workflow_version_id: f.wf.version_id,
    execution_environment: "dev" as const,
  };
  await Promise.all([
    prepareReportAuthority(input, ctx.testDb.db, f.principal),
    prepareReportAuthority(input, ctx.testDb.db, f.principal),
  ]);
  const runs = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_id, f.wf.workflow_id),
        eq(executions.hold_writes, true),
      ),
    );
  expect(runs).toHaveLength(1);
});

test("a recipient the author declares is reviewed, and the runtime still holds it to the wire", async () => {
  // The step this exists for cannot be observed at all: it sits behind a
  // condition that depends on a write a preparation holds back, so a held run
  // can never see past its own suppression. Without a way to state the
  // recipient, such a step is refused for good — and the advice it carried
  // ("let a preparation run") was a circle.
  //
  // This is not a way around the review. The author states who it goes to, a
  // human approves that statement, and the dispatcher still decodes the real
  // message and compares the recipient byte for byte. The last assertion is
  // the one that matters: a declaration that does not match what is sent is
  // refused at the wire, exactly as an observed one would be.
  const f = await fixture();
  const db = ctx.testDb.db;
  const [version] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.wf.version_id));
  const dag = version?.dag as { steps: Array<Record<string, unknown>> };
  const declared = {
    ...dag,
    steps: dag.steps.map((step) =>
      step.id === "send"
        ? {
            ...step,
            report_delivery: {
              kind: "gmail_report",
              to: "recipient@example.test",
              from: "sender@example.test",
              content_type: "text/html",
            },
          }
        : step,
    ),
  };
  await db
    .update(workflowVersions)
    .set({ dag: declared })
    .where(eq(workflowVersions.id, f.wf.version_id));

  // No preparation run has ever happened for this version, and the review is
  // nevertheless complete: the recipient is stated rather than observed.
  const preview = await f.inspect();
  expect(
    preview.manifest.effects.find((effect) => effect.step_id === "send")?.report_delivery?.to,
  ).toBe("recipient@example.test");
  expect(preview.request_refusals.find((entry) => entry.step_id === "send")).toBeUndefined();
  expect(preview.eligible_for_repeated_runs).toBe(true);

  await f.grant();
  let sent = 0;
  const remote = Object.assign(
    async () => {
      sent += 1;
      return Response.json({ id: "sent" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  await withDriverFetchForTests(remote, async () => {
    expect((await f.run()).status).toBe("succeeded");
    expect(sent).toBe(1);
    // The same approval, a message to somebody else: refused before egress.
    // This is the assertion the whole field rests on — a declaration is a
    // claim, and the wire is where it is checked.
    const elsewhere = Buffer.from(
      Buffer.from(f.raw, "base64url")
        .toString()
        .replace("recipient@example.test", "other@example.test"),
    ).toString("base64url");
    const refused = await f.run(elsewhere);
    expect(refused.status).toBe("failed");
    expect(refused.steps[0]?.error).toMatchObject({
      code: "execution_authority_changed",
      reason: "recipient_differs",
    });
    expect(sent).toBe(1);
  });
});

test("a declared recipient is contradicted only by what this version's preparation saw", async () => {
  // The declaration is believed until a held capture of this very step shows
  // otherwise. A capture recorded before inspections were recorded is no
  // evidence either way; a refused message or a different address is.
  const f = await fixture();
  const db = ctx.testDb.db;
  const [version] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.wf.version_id));
  const dag = version?.dag as { steps: Array<Record<string, unknown>> };
  const declaration = {
    kind: "gmail_report",
    to: "recipient@example.test",
    from: "sender@example.test",
    content_type: "text/html",
  };
  await db
    .update(workflowVersions)
    .set({
      dag: {
        ...dag,
        steps: dag.steps.map((step) =>
          step.id === "send" ? { ...step, report_delivery: declaration } : step,
        ),
      },
    })
    .where(eq(workflowVersions.id, f.wf.version_id));
  const [run] = await db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      workflow_version_id: f.wf.version_id,
      source_kind: "saved",
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
      hold_writes: true,
    })
    .returning();
  const [row] = await db
    .insert(executionSteps)
    .values({
      tenant_id: ctx.tenantId,
      execution_id: run?.id as string,
      step_key: "send",
      step_index: 0,
      kind: "request",
      status: "succeeded",
      request_meta: { driver: "http", url: GMAIL_SEND_TARGET, extras: { held: true } },
    })
    .returning();
  const capture = (extras: Record<string, unknown>) =>
    db
      .update(executionSteps)
      .set({
        request_meta: { driver: "http", url: GMAIL_SEND_TARGET, extras: { held: true, ...extras } },
      })
      .where(eq(executionSteps.id, row?.id as string));
  const verdict = async () => {
    const preview = await f.inspect();
    return {
      eligible: preview.eligible_for_repeated_runs,
      reason: preview.request_refusals.find((entry) => entry.step_id === "send")?.reason,
    };
  };

  expect(await verdict()).toEqual({ eligible: true, reason: undefined });
  await capture({ report_delivery_inspection: { ok: false, reason: "not_utf8" } });
  expect(await verdict()).toEqual({ eligible: false, reason: "report_delivery_contradicted" });
  await capture({
    report_delivery_inspection: { ok: true },
    report_delivery_proposal: { ...declaration, to: "other@example.test" },
  });
  expect(await verdict()).toEqual({ eligible: false, reason: "report_delivery_contradicted" });
  await capture({
    report_delivery_inspection: { ok: true },
    report_delivery_proposal: declaration,
  });
  expect(await verdict()).toEqual({ eligible: true, reason: undefined });
});
