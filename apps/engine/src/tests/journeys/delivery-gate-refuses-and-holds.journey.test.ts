import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps, patchCandidates, sessions, users } from "../../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../../execution/authority-admission.ts";
import { runExecution } from "../../execution/engine.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

describe("the delivery gate refuses an unsafe report and a held hook proposes its repair", () => {
  describe("a broken encoder is refused with its reason", () => {
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
      await withSelfHostedDriverFetchForTests(remote, async () => {
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
        expect(row?.error).toMatchObject({
          code: "execution_authority_changed",
          reason: "not_utf8",
        });
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

  describe("a held hook proposes its gate repair", () => {
    const SECRET = "whsec_j72_standardaaaaaaaaaaaaaaa";

    const HOOK = "watchkit-findings";

    const ENCODER = [
      "const subject = '[watchkit page] api.example.com — certificate expires';",
      "const html = '<p>watchkit.finding · api.example.com</p>';",
      "const msg = 'From: ops@example.com\\r\\nTo: ops@example.com\\r\\nSubject: ' + subject +",
      "  '\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n' + html;",
      "return { raw: sk.base64UrlEncode(msg) };",
    ].join("\n");

    let ctx: JourneyCtx;

    let workflowId = "";

    let versionId = "";

    function sign(id: string, ts: number, body: string): string {
      return `v1,${createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64")}`;
    }

    async function deliver(webhookId: string) {
      const body = JSON.stringify({ finding: webhookId });
      // allow-wall-clock: the HTTP ingress verifies the live signature window.
      const ts = Math.floor(Date.now() / 1000);
      return fetch(`${ctx.baseUrl}/v1/hooks/${HOOK}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sign(webhookId, ts, body),
        },
      });
    }

    const gateCandidates = () =>
      ctx.db
        .select({
          id: patchCandidates.id,
          status: patchCandidates.status,
          classification: patchCandidates.classification,
          diff: patchCandidates.diff,
        })
        .from(patchCandidates)
        .where(
          and(
            eq(patchCandidates.workflow_id, workflowId),
            like(patchCandidates.endpoint_key, "gate:%"),
          ),
        );

    async function gateJobs(): Promise<number> {
      const rows = (await ctx.db.execute(
        sql`SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = 'workflow.repair'
          AND data->>'trigger' = 'gate_block'
          AND data->>'workflow_id' = ${workflowId}`,
      )) as unknown as Array<{ n: number }> | { rows: Array<{ n: number }> };
      const list = Array.isArray(rows) ? rows : rows.rows;
      return list[0]?.n ?? 0;
    }

    async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
      for (let attempt = 0; attempt < 60; attempt++) {
        const value = await read();
        if (done(value)) return value;
        await Bun.sleep(500);
      }
      return read();
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("gate-hold-proposes-repair");
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
      const principal: ResolvedPrincipal = {
        provider: "session",
        kind: "user",
        id: user.id,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
        session_id: session.id,
      };
      const grantRequest = new Request("https://example.test/grant", {
        method: "POST",
        headers: {
          cookie: browserSessionCookie(await signBrowserSession(identity)),
          "x-subkit-csrf": await signBrowserCsrf(identity),
        },
      });

      const wf = await seedWorkflow(ctx, {
        slug: "watchkit-finding-mail",
        name: "WatchKit finding mail",
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
      workflowId = wf.id;
      versionId = wf.version_id;

      const review = await previewWorkflowAuthority(
        {
          tenant_id: ctx.tenantId,
          workflow_id: wf.id,
          workflow_version_id: wf.version_id,
          execution_environment: "prod",
        },
        ctx.db,
      );
      expect(review.eligible_for_repeated_runs).toBe(true);
      await grantWorkflowAuthority(
        wf.id,
        {
          workflow_version_id: wf.version_id,
          expected_manifest_digest: review.digest,
          execution_environment: "prod",
          valid_from: now.toISOString(),
          valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
          max_runs: 1,
        },
        { db: ctx.db, request: grantRequest, principal },
      );
      const remote = Object.assign(async () => Response.json({ id: "sent" }), {
        preconnect: () => {},
      }) as typeof fetch;
      await withSelfHostedDriverFetchForTests(remote, async () => {
        const admitted = await admitAuthorizedWorkflowExecution(
          {
            tenant_id: ctx.tenantId,
            workflow_id: wf.id,
            execution_environment: "prod",
            request_source: "scheduler",
            input: {},
          },
          ctx.db,
        );
        const result = await runExecution({
          tenant_id: ctx.tenantId,
          db: ctx.db,
          source: { kind: "saved", workflow_id: wf.id },
          input: {},
          options: { existing_execution_id: admitted.execution_id },
        });
        expect(result.status).toBe("failed");
      });

      const binding = await journeyFetch(ctx, "/v1/webhooks/inbound", {
        method: "POST",
        body: JSON.stringify({
          slug: HOOK,
          workflow_id: workflowId,
          verifier: "standard",
          secret: SECRET,
        }),
      });
      expect(binding.status).toBe(201);
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1 + AC2: the refused delivery queues one diagnosis and one gate_fix appears", async () => {
      const refused = await deliver("finding-1");
      expect(refused.status).toBe(409);
      expect(await gateJobs()).toBe(1);
      const candidates = await waitFor(gateCandidates, (rows) => rows.length > 0);
      expect(candidates).toHaveLength(1);
      const [candidate] = candidates;
      expect(candidate?.classification).toBe("unsafe");
      expect(candidate?.status).toBe("proposed");
      expect(candidate?.diff).toMatchObject({
        base_version_id: versionId,
        environment: "prod",
        source: "gate_block",
        proposal: { kind: "gate_fix", patch: { fixer: "use_utf8_encoder" } },
      });
    });

    test("AC3: a repeated refusal queues nothing and leaves one candidate", async () => {
      const again = await deliver("finding-2");
      expect(again.status).toBe(409);
      expect(await gateJobs()).toBe(1);
      await Bun.sleep(3_000);
      expect(await gateCandidates()).toHaveLength(1);
    });
  });
});
