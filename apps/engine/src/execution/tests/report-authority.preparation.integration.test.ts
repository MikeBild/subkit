import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionSteps, executions, workflowVersions } from "../../db/schema/index.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { prepareReportAuthority } from "../../workflows/prepare-report-authority.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { isSensitivePayload } from "../sensitive-payload.ts";
import { createExecution } from "../state.ts";
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

test("a report step the profile has already bounded reports no refusal at all", async () => {
  const f = await fixture();
  await f.prepare();
  const preview = await f.inspect();
  expect(
    preview.manifest.effects.find((effect) => effect.step_id === "send")?.report_delivery?.to,
  ).toBe("recipient@example.test");
  expect(preview.request_refusals.find((entry) => entry.step_id === "send")).toBeUndefined();
});

test("a preparation that is already running is refused with a reason, not started twice", async () => {
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

test("two preparations at once never run side by side", async () => {
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
    .select({ started: executions.started_at, finished: executions.finished_at })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_id, f.wf.workflow_id),
        eq(executions.hold_writes, true),
      ),
    )
    .orderBy(executions.started_at);
  expect(runs.length).toBeGreaterThanOrEqual(1);
  expect(runs.length).toBeLessThanOrEqual(2);
  if (runs.length === 2) {
    const [first, second] = runs;
    expect(first?.finished).not.toBeNull();
    expect(second!.started!.getTime()).toBeGreaterThanOrEqual(first!.finished!.getTime());
  }
});

test("a recipient the author declares is reviewed, and the runtime still holds it to the wire", async () => {
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
  await withSelfHostedDriverFetchForTests(remote, async () => {
    expect((await f.run()).status).toBe("succeeded");
    expect(sent).toBe(1);
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

test("another product owner's running preparation cannot block or supply this owner's preparation", async () => {
  const f = await fixture();
  const db = ctx.testDb.db;
  const [version] = await db
    .select()
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, f.wf.version_id)),
    );
  if (!version) throw new Error("missing fixture version");
  await db
    .update(workflowVersions)
    .set({
      dag: {
        ...(version.dag as Record<string, unknown>),
        product_id: "harmoniqs",
        required_caller_kind: "user",
      },
    })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, version.id)));
  const principal = { ...f.principal, product_id: "harmoniqs" };
  const other = { ...principal, id: "00000000-0000-4000-8000-000000000043" };
  const foreignId = await createExecution(db, {
    tenant_id: ctx.tenantId,
    workflow_id: f.wf.workflow_id,
    workflow_version_id: f.wf.version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "ui",
    execution_mode: "dev",
    input: { raw: "foreign-input", window: 13 },
    hold_writes: true,
    caller_context: callerFromPrincipal(other, ctx.tenantId, "harmoniqs"),
  });
  const result = await prepareReportAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      workflow_version_id: f.wf.version_id,
      execution_environment: "dev",
      input: { raw: f.raw, window: f.raw.length },
    },
    db,
    principal,
  );
  expect(result.prepared).toBe(true);
  const rows = await db
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, f.wf.workflow_id)),
    );
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id !== foreignId)?.caller_context?.principalId).toBe(principal.id);
});

test("sensitive report preparation creates encrypted held input for its authenticated owner", async () => {
  const f = await fixture();
  const db = ctx.testDb.db;
  const [version] = await db
    .select()
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, f.wf.version_id)),
    );
  if (!version) throw new Error("missing fixture version");
  await db
    .update(workflowVersions)
    .set({ dag: { ...(version.dag as Record<string, unknown>), execution_privacy: "sensitive" } })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, version.id)));
  const result = await prepareReportAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: f.wf.workflow_id,
      workflow_version_id: f.wf.version_id,
      execution_environment: "dev",
      input: { raw: f.raw, window: f.raw.length },
    },
    db,
    f.principal,
  );
  expect(result.prepared).toBe(true);
  const [row] = await db
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, f.wf.workflow_id)),
    );
  expect(row?.hold_writes).toBe(true);
  expect(row?.caller_context?.principalId).toBe(f.principal.id);
  expect(isSensitivePayload(row?.input)).toBe(true);
  expect(JSON.stringify(row?.input)).not.toContain(f.raw);
});
