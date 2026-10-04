// One block, one repair: a held preparation and a refused granted run name the
// same encoder cause under two gate codes, and the repair is filed once; a
// person's rejection keeps holding for that version; a draft is diagnosed but
// never repaired.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { inspectAutomationReview } from "../../conversations/automation-review.ts";
import {
  connectors,
  executionSteps,
  executions,
  patchCandidates,
  sessions,
  users,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../../execution/authority-admission.ts";
import { runExecution } from "../../execution/engine.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { diagnoseWorkflow } from "../../workflows/gate-diagnosis.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { rejectPatchCandidate } from "../candidate-decision.ts";
import { previewPatchCandidate } from "../candidate-review.ts";
import { proposeGateRepairs } from "../gate-repairs.ts";

let ctx: EngineTestCtx;
let principal: ResolvedPrincipal;
let grantRequest: Request;
let sequence = 0;

const ENCODER = [
  "const msg = 'From: ops@example.com\\r\\nTo: ops@example.com\\r\\nSubject: a — b' +",
  "  '\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n<p>·</p>';",
  "return { raw: sk.base64UrlEncode(msg) };",
].join("\n");

async function seed() {
  return createWorkflowRow(ctx, {
    name: "Finding mail",
    slug: `finding-mail-${++sequence}`,
    steps: [
      { kind: "transform", id: "compose", language: "javascript", expression: ENCODER },
      {
        kind: "request",
        id: "send_email",
        method: "POST",
        url: GMAIL_SEND_TARGET,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { raw: "${scope.compose.data.raw}" },
        report_delivery: {
          kind: "gmail_report",
          to: "ops@example.com",
          from: "ops@example.com",
          content_type: "text/html",
        },
        max_retries: 0,
      },
    ],
  });
}

async function refusedGrantedRun(workflow_id: string, version_id: string, max_runs = 1) {
  const db = ctx.testDb.db;
  const review = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      execution_environment: "dev",
    },
    db,
  );
  const now = await databaseNow(db);
  await grantWorkflowAuthority(
    workflow_id,
    {
      workflow_version_id: version_id,
      expected_manifest_digest: review.digest,
      execution_environment: "dev",
      valid_from: now.toISOString(),
      valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
      max_runs,
    },
    { db, request: grantRequest, principal },
  );
  const remote = Object.assign(async () => Response.json({ id: "sent" }), {
    preconnect: () => {},
  }) as typeof fetch;
  await withDriverFetchForTests(remote, async () => {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id,
        execution_environment: "dev",
        request_source: "scheduler",
        input: {},
      },
      db,
    );
    await runExecution({
      tenant_id: ctx.tenantId,
      db,
      source: { kind: "saved", workflow_id },
      input: {},
      options: { existing_execution_id: admitted.execution_id, principal },
    });
  });
}

async function preparation(workflow_id: string) {
  await runExecution({
    tenant_id: ctx.tenantId,
    db: ctx.testDb.db,
    source: { kind: "saved", workflow_id },
    input: {},
    options: { hold_writes: true, execution_mode: "dev", principal },
  });
}

beforeAll(async () => {
  ctx = await createEngineCtx("gate-repairs");
  const db = ctx.testDb.db;
  const now = await databaseNow(db);
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "approver@example.com",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  principal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    session_id: session.id,
  };
  grantRequest = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

const target = (workflow_id: string, version_id: string) => ({
  tenant_id: ctx.tenantId,
  workflow_id,
  version_id,
  environment: "dev" as const,
});

test("a held refusal and a granted refusal of the same cause file one candidate", async () => {
  const wf = await seed();
  await refusedGrantedRun(wf.workflow_id, wf.version_id);
  await preparation(wf.workflow_id);
  const diagnosis = await diagnoseWorkflow(ctx.testDb.db, ctx.tenantId, wf.workflow_id, "dev");
  const fixable = diagnosis?.diagnoses.filter((entry) => entry.fixer) ?? [];
  expect(fixable).toHaveLength(1);
  expect(fixable[0]).toMatchObject({ reason: "not_utf8", fixer: "use_utf8_encoder" });

  const first = await proposeGateRepairs(ctx.testDb.db, target(wf.workflow_id, wf.version_id));
  const again = await proposeGateRepairs(ctx.testDb.db, target(wf.workflow_id, wf.version_id));
  expect(first).toHaveLength(1);
  expect(first[0]?.created).toBe(true);
  expect(again).toEqual([{ ...first[0], created: false } as never]);
  const rows = await ctx.testDb.db
    .select()
    .from(patchCandidates)
    .where(eq(patchCandidates.workflow_id, wf.workflow_id));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.classification).toBe("unsafe");
  expect(rows[0]?.diff).toMatchObject({ source: "gate_block" });
});

test("a rejection holds for the version it was given on", async () => {
  const wf = await seed();
  await refusedGrantedRun(wf.workflow_id, wf.version_id);
  const [proposed] = await proposeGateRepairs(ctx.testDb.db, target(wf.workflow_id, wf.version_id));
  if (!proposed) throw new Error("no candidate proposed");
  await rejectPatchCandidate(
    { tenant_id: ctx.tenantId, candidate_id: proposed.candidate_id, actor_id: null },
    ctx.testDb.db,
  );
  const [again] = await proposeGateRepairs(ctx.testDb.db, target(wf.workflow_id, wf.version_id));
  expect(again).toMatchObject({
    candidate_id: proposed.candidate_id,
    status: "rejected",
    created: false,
  });
});

test("a draft is diagnosed but never repaired", async () => {
  const wf = await seed();
  await refusedGrantedRun(wf.workflow_id, wf.version_id);
  const db = ctx.testDb.db;
  const [current] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, wf.version_id));
  const [draft] = await db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id: wf.workflow_id, version: 2, dag: current?.dag })
    .returning();
  if (!draft) throw new Error("draft insert failed");
  await db
    .update(workflows)
    .set({ draft_version_id: draft.id })
    .where(and(eq(workflows.id, wf.workflow_id), eq(workflows.tenant_id, ctx.tenantId)));
  const diagnosis = await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev");
  expect(diagnosis).toMatchObject({ workflow_version_id: draft.id, is_current: false });
  expect(await proposeGateRepairs(db, target(wf.workflow_id, draft.id))).toEqual([]);
  // The running version a refused start is about can still be asked for by id.
  const running = await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev", {
    version_id: wf.version_id,
  });
  expect(running).toMatchObject({ workflow_version_id: wf.version_id, is_current: true });
  expect(running?.diagnoses.map((entry) => entry.subject.step_id)).toContain("send_email");
  // A version that is not this workflow's is not found — never a clean bill.
  expect(
    await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev", {
      version_id: "00000000-0000-4000-8000-0000000000aa",
    }),
  ).toBeNull();
});

test("a contradicted declaration on a connector-backed send is declared from what was observed", async () => {
  const db = ctx.testDb.db;
  const [gmail] = await db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: `gmail-${++sequence}`,
      display_name: "Gmail",
      driver: "http",
      auth_type: "none",
      base_url: "https://gmail.googleapis.com",
      config: {},
      environment: "dev",
    })
    .returning();
  if (!gmail) throw new Error("connector insert failed");
  const wf = await createWorkflowRow(ctx, {
    name: "Finding mail via connector",
    slug: `finding-mail-${++sequence}`,
    steps: [
      {
        kind: "transform",
        id: "compose",
        language: "javascript",
        expression: ENCODER.replace("sk.base64UrlEncode(", "sk.base64UrlEncodeUtf8("),
      },
      {
        kind: "request",
        id: "send_email",
        connector_id: gmail.id,
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { raw: "${scope.compose.data.raw}" },
        report_delivery: {
          kind: "gmail_report",
          to: "other@example.com",
          from: "ops@example.com",
          content_type: "text/html",
        },
        max_retries: 0,
      },
    ],
  });
  await preparation(wf.workflow_id);
  const diagnosis = await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev");
  const send = diagnosis?.diagnoses.find((entry) => entry.subject.step_id === "send_email");
  expect(send).toMatchObject({
    code: "report_delivery_contradicted",
    remedy_kind: "declare",
    fixer: "declare_report_delivery",
    evidence: { observed: { to: "ops@example.com", from: "ops@example.com" } },
  });
  const [proposed] = await proposeGateRepairs(db, target(wf.workflow_id, wf.version_id));
  if (!proposed) throw new Error("no candidate proposed");
  const preview = await previewPatchCandidate(ctx.tenantId, proposed.candidate_id, db);
  expect(preview?.reviewable).toBe(true);
  expect(preview?.after_step?.report_delivery).toMatchObject({ to: "ops@example.com" });
  expect(preview?.before_step?.report_delivery).toMatchObject({ to: "other@example.com" });
  // The reviewer sees which run the declaration was copied from.
  expect(preview?.proposal?.patch).toMatchObject({
    source_execution_id: send?.evidence.execution_id,
  });
});

test("the automation review carries the repair and its candidate", async () => {
  const wf = await seed();
  await refusedGrantedRun(wf.workflow_id, wf.version_id);
  const [proposed] = await proposeGateRepairs(ctx.testDb.db, target(wf.workflow_id, wf.version_id));
  await ctx.testDb.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenantId,
    workflow_id: wf.workflow_id,
    cron: "0 7 * * *",
    execution_mode: "dev",
    input: {},
  });
  const review = await inspectAutomationReview(ctx.testDb.db, ctx.tenantId, wf.workflow_id);
  const guidance = review?.schedules[0]?.review.repair_guidance ?? [];
  expect(guidance.find((entry) => entry.step_id === "send_email")).toMatchObject({
    fixer: "use_utf8_encoder",
    remedy_kind: "patch",
    reason: "not_utf8",
    candidate_id: proposed?.candidate_id,
  });
});

test("another governance refusal is not relabelled as a changed approval", async () => {
  const wf = await seed();
  await refusedGrantedRun(wf.workflow_id, wf.version_id);
  const db = ctx.testDb.db;
  // The same refused row, as if a declared request boundary had refused it.
  await db
    .update(executionSteps)
    .set({ error: { code: "request_outside_declared_boundary", message: "outside" } })
    .where(
      and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.step_key, "send_email")),
    );
  const diagnosis = await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev");
  expect(
    diagnosis?.diagnoses.filter((entry) => entry.code === "execution_authority_changed"),
  ).toEqual([]);
});

/**
 * A later run of the same version, as its rows record it: admitted under the
 * refused run's approval (or none), a minute after it, with `step_key`
 * completed.
 */
async function laterRun(
  workflow_id: string,
  step_key: string,
  options: { held?: boolean; granted?: boolean } = {},
) {
  const db = ctx.testDb.db;
  const [refused] = await db
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_id, workflow_id),
        eq(executions.status, "failed"),
      ),
    )
    .limit(1);
  if (!refused) throw new Error("no refused run to follow");
  const later = new Date((await databaseNow(db)).getTime() + 60_000);
  // An approved run is admitted queued — the database reserves its run then.
  const [run] = await db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: refused.workflow_version_id,
      execution_authority_id: options.granted === false ? null : refused.execution_authority_id,
      hold_writes: options.held === true,
      status: "queued",
      request_source: "scheduler",
      execution_mode: refused.execution_mode,
      created_at: later,
    })
    .returning();
  if (!run) throw new Error("later run insert failed");
  await db
    .update(executions)
    .set({ status: "succeeded", finished_at: later })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, run.id)));
  await db.insert(executionSteps).values({
    tenant_id: ctx.tenantId,
    execution_id: run.id,
    step_key,
    kind: "request",
    status: "succeeded",
    held: options.held === true,
    started_at: later,
    finished_at: later,
  });
}

const changedApproval = async (workflow_id: string) =>
  (await diagnoseWorkflow(ctx.testDb.db, ctx.tenantId, workflow_id, "dev"))?.diagnoses.filter(
    (entry) => entry.code === "execution_authority_changed",
  ) ?? [];

test("a refusal is history once a later granted run of the version got past that step", async () => {
  const wf = await seed();
  // Room on the approval for the granted runs that follow the refusal.
  await refusedGrantedRun(wf.workflow_id, wf.version_id, 5);
  expect(await changedApproval(wf.workflow_id)).toHaveLength(1);

  // Success elsewhere, a preparation (held, and never under an approval), and
  // an ungranted run prove nothing about whether the approval fits this step.
  await laterRun(wf.workflow_id, "compose");
  await laterRun(wf.workflow_id, "send_email", { held: true, granted: false });
  await laterRun(wf.workflow_id, "send_email", { granted: false });
  expect(await changedApproval(wf.workflow_id)).toHaveLength(1);

  // A loop iteration of the step is the step.
  await laterRun(wf.workflow_id, "send_email[0]");
  expect(await changedApproval(wf.workflow_id)).toEqual([]);
});

test("a declaration is never copied from what another version observed", async () => {
  const db = ctx.testDb.db;
  // Version 1 sends correctly encoded mail; a preparation observes it.
  const wf = await createWorkflowRow(ctx, {
    name: "Finding mail across versions",
    slug: `finding-mail-${++sequence}`,
    steps: [
      {
        kind: "transform",
        id: "compose",
        language: "javascript",
        expression: ENCODER.replace("sk.base64UrlEncode(", "sk.base64UrlEncodeUtf8("),
      },
      {
        kind: "request",
        id: "send_email",
        method: "POST",
        url: GMAIL_SEND_TARGET,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { raw: "${scope.compose.data.raw}" },
        report_delivery: {
          kind: "gmail_report",
          to: "ops@example.com",
          from: "ops@example.com",
          content_type: "text/html",
        },
        max_retries: 0,
      },
    ],
  });
  await preparation(wf.workflow_id);
  // Version 2 is a different message to a different declared recipient, and
  // has never been prepared. Its granted run is refused as addressed
  // differently from its declaration.
  const [v1] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, wf.version_id));
  const dag = JSON.parse(
    JSON.stringify(v1?.dag)
      .replace("sk.base64UrlEncodeUtf8(", "sk.base64UrlEncode(")
      .replace('"to":"ops@example.com"', '"to":"other@example.com"'),
  );
  const [v2] = await db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id: wf.workflow_id, version: 2, dag })
    .returning();
  if (!v2) throw new Error("version insert failed");
  await db
    .update(workflows)
    .set({ current_version_id: v2.id })
    .where(and(eq(workflows.id, wf.workflow_id), eq(workflows.tenant_id, ctx.tenantId)));
  await refusedGrantedRun(wf.workflow_id, v2.id);
  const [refusedRun] = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, ctx.tenantId),
        eq(executions.workflow_version_id, v2.id),
        eq(executions.status, "failed"),
      ),
    );
  if (!refusedRun) throw new Error("no refused run on version 2");
  await db
    .update(executionSteps)
    .set({ error: { code: "execution_authority_changed", reason: "recipient_differs" } })
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, refusedRun.id),
        eq(executionSteps.step_key, "send_email"),
      ),
    );

  const diagnosis = await diagnoseWorkflow(db, ctx.tenantId, wf.workflow_id, "dev");
  expect(diagnosis).toMatchObject({ workflow_version_id: v2.id, is_current: true });
  const refused = diagnosis?.diagnoses.find(
    (entry) => entry.code === "execution_authority_changed",
  );
  expect(refused).toMatchObject({ reason: "recipient_differs", remedy_kind: "declare" });
  expect(refused?.fixer).toBeUndefined();
  expect(refused?.evidence.observed).toBeUndefined();
  expect(diagnosis?.diagnoses.some((entry) => entry.fixer === "declare_report_delivery")).toBe(
    false,
  );
  expect(await proposeGateRepairs(db, target(wf.workflow_id, v2.id))).toEqual([]);
});
