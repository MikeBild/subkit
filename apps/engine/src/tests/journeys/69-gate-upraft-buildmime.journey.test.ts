import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, seedWorkflow } from "./setup.ts";

let ctx: JourneyCtx;
let wf: { id: string; version_id: string };
let preparationId = "";

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

describe("journey 69: a buildMimeMessage report is reviewable from its preparation", () => {
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
    expect(review.request_refusals.find((entry) => entry.step_id === "send_email")).toBeUndefined();
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
