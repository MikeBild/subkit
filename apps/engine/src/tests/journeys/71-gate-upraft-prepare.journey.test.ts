// User story: As an author whose report e-mail is built with the engine's own
// `sk.buildMimeMessage` — a named sender and a plain-text alternative — I am
// told that the review only lacks a preparation run, not handed a code patch
// for a message that is fine.
// Acceptance criteria:
//   - AC1: Before any preparation, GET /v1/workflows/{id}/diagnosis names the
//     report step with remedy `prepare` and no fixer.
//   - AC2: Asking for repairs files nothing: proposeGateRepairs returns no
//     candidate, POST /v1/workflows/{id}/repairs is refused, and no patch
//     candidate exists for the workflow.
//   - AC3: After a preparation run the diagnosis offers no fixer for the step
//     either — whatever the review then says, no encoder patch is proposed.
// Spec refs: docs/concepts/self-healing.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { patchCandidates } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { proposeGateRepairs } from "../../self-healing/index.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let wf: { id: string; version_id: string };

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

describe("journey 71: a buildMimeMessage report is told to prepare, never patched", () => {
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
});
