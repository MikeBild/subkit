import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps, executions, patchCandidates } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { proposeGateRepairs } from "../../self-healing/index.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const COMPOSE = [
  "const html = '<h1>Login check</h1><p>Prüfung ok – ' + input.input.at + '</p>';",
  "const text = 'Login check\\nPrüfung ok – ' + input.input.at;",
  "return sk.buildMimeMessage({",
  "  from: 'Upraft Auth <ops@example.com>',",
  "  to: 'ops@example.com',",
  "  subject: 'Upraft Auth: login – Prüfung ok',",
  "  html,",
  "  text,",
  "});",
].join("\n");

describe("the delivery gate reviews a buildMimeMessage report from its preparation", () => {
  describe("a prepared report is reviewable", () => {
    let ctx: JourneyCtx;

    let wf: { id: string; version_id: string };

    let preparationId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("gate-upraft-buildmime");
      wf = await seedWorkflow(ctx, {
        slug: "login-check-report",
        name: "Login check report",
        steps: [
          { kind: "transform", id: "compose", language: "javascript", expression: COMPOSE },
          {
            kind: "request",
            id: "send_email",
            method: "POST",
            url: GMAIL_SEND_TARGET,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
            body: { raw: "${scope.compose.data.raw}" },
            max_retries: 0,
          },
        ],
      });
      const principal: ResolvedPrincipal = {
        provider: "api_key",
        kind: "system_account",
        id: ctx.systemAccountId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      };
      const prepared = await runExecution({
        tenant_id: ctx.tenantId,
        db: ctx.db,
        source: { kind: "saved", workflow_id: wf.id },
        input: { at: "2026-01-01T00:00:00Z" },
        options: { hold_writes: true, execution_mode: "dev", principal },
      });
      preparationId = prepared.execution_id;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: the held step records an ok inspection and the multipart proposal", async () => {
      const [row] = await ctx.db
        .select({ meta: executionSteps.request_meta })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.execution_id, preparationId),
            eq(executionSteps.step_key, "send_email"),
          ),
        );
      const extras = (row?.meta as { extras?: Record<string, unknown> } | null)?.extras;
      expect(extras?.held).toBe(true);
      expect(extras?.report_delivery_inspection).toEqual({ ok: true });
      expect(extras?.report_delivery_proposal).toEqual({
        kind: "gmail_report",
        to: "ops@example.com",
        from: "ops@example.com",
        content_type: "multipart/alternative",
      });
    });

    test("AC2: the review proposes that boundary and is eligible", async () => {
      const review = await previewWorkflowAuthority(
        {
          tenant_id: ctx.tenantId,
          workflow_id: wf.id,
          workflow_version_id: wf.version_id,
          execution_environment: "dev",
        },
        ctx.db,
      );
      expect(
        review.request_refusals.find((entry) => entry.step_id === "send_email"),
      ).toBeUndefined();
      expect(
        review.manifest.effects.find((effect) => effect.step_id === "send_email")?.report_delivery,
      ).toEqual({
        kind: "gmail_report",
        to: "ops@example.com",
        from: "ops@example.com",
        content_type: "multipart/alternative",
      });
      expect(review.eligible_for_repeated_runs).toBe(true);
    });
  });

  describe("an unprepared report is told to prepare, never patched", () => {
    let ctx: JourneyCtx;

    let wf: { id: string; version_id: string };

    interface Diagnosis {
      code: string;
      subject: { step_id: string };
      remedy_kind: string;
      fixer?: string;
    }

    async function diagnosis(): Promise<Diagnosis[]> {
      const res = await journeyFetch(ctx, `/v1/workflows/${wf.id}/diagnosis?environment=dev`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { diagnoses: Diagnosis[] }).diagnoses;
    }

    async function candidates() {
      return ctx.db.select().from(patchCandidates).where(eq(patchCandidates.workflow_id, wf.id));
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("gate-upraft-prepare");
      wf = await seedWorkflow(ctx, {
        slug: "login-check-report",
        name: "Login check report",
        steps: [
          { kind: "transform", id: "compose", language: "javascript", expression: COMPOSE },
          {
            kind: "request",
            id: "send_email",
            method: "POST",
            url: GMAIL_SEND_TARGET,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
            body: { raw: "${scope.compose.data.raw}" },
            max_retries: 0,
          },
        ],
      });
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1 + AC2: unprepared reads `prepare` and files no candidate", async () => {
      const send = (await diagnosis()).find((entry) => entry.subject.step_id === "send_email");
      expect(send).toMatchObject({ code: "report_delivery_unprepared", remedy_kind: "prepare" });
      expect(send?.fixer).toBeUndefined();

      expect(
        await proposeGateRepairs(ctx.db, {
          tenant_id: ctx.tenantId,
          workflow_id: wf.id,
          version_id: wf.version_id,
          environment: "dev",
        }),
      ).toEqual([]);
      const refused = await journeyFetch(ctx, `/v1/workflows/${wf.id}/repairs`, {
        method: "POST",
        body: JSON.stringify({
          step_id: "send_email",
          fixer: "use_utf8_encoder",
          environment: "dev",
        }),
      });
      expect(refused.status).toBe(409);
      expect(await candidates()).toEqual([]);
    });

    test("AC3: after a preparation run no fixer is offered for the step", async () => {
      const principal: ResolvedPrincipal = {
        provider: "api_key",
        kind: "system_account",
        id: ctx.systemAccountId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      };
      await runExecution({
        tenant_id: ctx.tenantId,
        db: ctx.db,
        source: { kind: "saved", workflow_id: wf.id },
        input: { at: "2026-01-01T00:00:00Z" },
        options: { hold_writes: true, execution_mode: "dev", principal },
      });
      const send = (await diagnosis()).find((entry) => entry.subject.step_id === "send_email");
      expect(send?.fixer).toBeUndefined();
      await proposeGateRepairs(ctx.db, {
        tenant_id: ctx.tenantId,
        workflow_id: wf.id,
        version_id: wf.version_id,
        environment: "dev",
      });
      expect(await candidates()).toEqual([]);
    });
    test("AC4: a capture that predates inspections asks for a preparation", async () => {
      const [held] = await ctx.db
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.workflow_id, wf.id), eq(executions.hold_writes, true)));
      if (!held) throw new Error("missing held run");
      await ctx.db
        .update(executionSteps)
        .set({
          request_meta: sql`${executionSteps.request_meta} #- '{extras,report_delivery_inspection}'::text[] #- '{extras,report_delivery_proposal}'::text[]`,
        })
        .where(
          and(eq(executionSteps.execution_id, held.id), eq(executionSteps.step_key, "send_email")),
        );
      const send = (await diagnosis()).find((entry) => entry.subject.step_id === "send_email");
      expect(send).toMatchObject({ code: "report_delivery_unobserved", remedy_kind: "prepare" });
      expect(send?.fixer).toBeUndefined();
    });
  });
});
