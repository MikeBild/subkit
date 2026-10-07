import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps, sessions, users } from "../../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../../execution/authority-admission.ts";
import { runExecution } from "../../execution/engine.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, seedWorkflow } from "./setup.ts";

let ctx: JourneyCtx;
let principal: ResolvedPrincipal;
let grantRequest: Request;

const ENCODER = [
  "const subject = '[watchkit page] api.example.com — certificate expires';",
  "const html = '<p>watchkit.finding · api.example.com · ' + input.input.at + '</p>';",
  "const msg = 'From: ops@example.com\\r\\nTo: ops@example.com\\r\\nSubject: ' + subject +",
  "  '\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n' + html;",
  "return { raw: sk.base64UrlEncode(msg) };",
].join("\n");

function steps() {
  return [
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
  ];
}

const preview = (wf: { id: string; version_id: string }) =>
  previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      workflow_version_id: wf.version_id,
      execution_environment: "dev",
    },
    ctx.db,
  );

beforeAll(async () => {
  ctx = await createJourneyCtx("gate-watchkit-binary-encoder");
  const now = await databaseNow(ctx.db);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "approver@example.com",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await ctx.db
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
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 68: a declared report the encoder breaks is refused with its reason", () => {
  test("AC1 + AC2: eligible on declaration alone, refused at dispatch with not_utf8", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail",
      name: "Finding mail",
      steps: steps(),
    });
    const review = await preview(wf);
    expect(review.eligible_for_repeated_runs).toBe(true);

    const now = await databaseNow(ctx.db);
    await grantWorkflowAuthority(
      wf.id,
      {
        workflow_version_id: wf.version_id,
        expected_manifest_digest: review.digest,
        execution_environment: "dev",
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
        max_runs: 1,
      },
      { db: ctx.db, request: grantRequest, principal },
    );

    let sends = 0;
    const remote = Object.assign(
      async () => {
        sends += 1;
        return Response.json({ id: "sent" });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    await withDriverFetchForTests(remote, async () => {
      const input = { at: "2026-01-01T00:00:00Z" };
      const admitted = await admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id: wf.id,
          execution_environment: "dev",
          request_source: "scheduler",
          input,
        },
        ctx.db,
      );
      const result = await runExecution({
        tenant_id: ctx.tenantId,
        db: ctx.db,
        source: { kind: "saved", workflow_id: wf.id },
        input,
        options: { existing_execution_id: admitted.execution_id },
      });
      expect(result.status).toBe("failed");
      const send = result.steps.find((step) => step.step_key === "send_email");
      expect(send?.error).toMatchObject({
        code: "execution_authority_changed",
        reason: "not_utf8",
      });
      expect(sends).toBe(0);
      const [row] = await ctx.db
        .select({ error: executionSteps.error })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.execution_id, admitted.execution_id),
            eq(executionSteps.step_key, "send_email"),
          ),
        );
      expect(row?.error).toMatchObject({ code: "execution_authority_changed", reason: "not_utf8" });
    });
  });

  test("AC3: a preparation that reached the step contradicts the declaration", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail-prepared",
      name: "Finding mail prepared",
      steps: steps(),
    });
    await runExecution({
      tenant_id: ctx.tenantId,
      db: ctx.db,
      source: { kind: "saved", workflow_id: wf.id },
      input: { at: "2026-01-01T00:00:00Z" },
      options: { hold_writes: true, execution_mode: "dev", principal },
    });
    const review = await preview(wf);
    expect(review.request_refusals.find((entry) => entry.step_id === "send_email")?.reason).toBe(
      "report_delivery_contradicted",
    );
    expect(review.eligible_for_repeated_runs).toBe(false);
  });
});
