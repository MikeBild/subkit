import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { grantScheduleAuthorityFixture } from "../../scheduler/tests/authority-fixture.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const SECRET = "whsec_j73_standardaaaaaaaaaaaaaaa";
const HOOK = "findings-admitted";
const INPUT_SCHEMA = {
  type: "object",
  required: ["body"],
  properties: { body: { type: "object", required: ["raw"] } },
};
const RAW = Buffer.from(
  [
    "From: reports@example.com",
    "To: owner@example.com",
    "Subject: Finding",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "admitted-sample-marker",
  ].join("\r\n"),
).toString("base64url");

function sign(id: string, ts: number, body: string): string {
  return `v1,${createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

let ctx: JourneyCtx;
let workflowId = "";
let bindableVersionId = "";
let reportVersionId = "";

const heldRuns = async () =>
  ctx.db
    .select({ id: executions.id, input: executions.input })
    .from(executions)
    .where(and(eq(executions.workflow_id, workflowId), eq(executions.hold_writes, true)));

const activate = (versionId: string) =>
  ctx.db
    .update(workflows)
    .set({ current_version_id: versionId })
    .where(eq(workflows.id, workflowId));

const prepare = () =>
  journeyFetch(ctx, `/v1/workflows/${workflowId}/versions/${reportVersionId}/prepare-authority`, {
    method: "POST",
    body: JSON.stringify({ environment: "prod" }),
  });

beforeAll(async () => {
  ctx = await createJourneyCtx("admitted-sample");
  const wf = await seedWorkflow(ctx, {
    slug: "finding-intake",
    name: "Finding intake",
    steps: [{ id: "shape", kind: "transform", expression: "$" }],
  });
  workflowId = wf.id;
  bindableVersionId = wf.version_id;
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Finding intake",
        slug: "finding-intake",
        input_schema: INPUT_SCHEMA,
        steps: [{ id: "shape", kind: "transform", expression: "$" }],
      },
    })
    .where(eq(workflowVersions.id, bindableVersionId));
  await grantScheduleAuthorityFixture(ctx.db, ctx.tenantId, workflowId);
  const [report] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      version: 2,
      dag: {
        name: "Finding intake",
        slug: "finding-intake",
        input_schema: INPUT_SCHEMA,
        steps: [
          {
            id: "notify",
            kind: "request",
            method: "POST",
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression
            body: { raw: "${input.body.raw}" },
            max_retries: 0,
          },
        ],
      },
    })
    .returning();
  if (!report) throw new Error("report version missing");
  reportVersionId = report.id;
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

describe("journey: a preparation uses the latest admitted delivery", () => {
  test("AC1: with no admitted delivery the preparation still asks for a sample", async () => {
    await activate(reportVersionId);
    const res = await prepare();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prepared: false,
      reason: "input_required",
      trigger: { kind: "inbound_hook", slug: HOOK },
    });
    expect(await heldRuns()).toHaveLength(0);
  });

  test("AC2+AC3: after one admitted delivery the preparation runs held over it", async () => {
    await activate(bindableVersionId);
    const body = JSON.stringify({ raw: RAW });
    const webhookId = "admitted-delivery";
    // allow-wall-clock: the HTTP ingress verifies the live signature window.
    const ts = Math.floor(Date.now() / 1000);
    const delivered = await fetch(`${ctx.baseUrl}/v1/hooks/${HOOK}`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(ts),
        "webhook-type": "finding.created",
        "webhook-signature": sign(webhookId, ts, body),
      },
    });
    expect(delivered.status).toBe(200);
    const [admitted] = await ctx.db
      .select({ input: executions.input })
      .from(executions)
      .where(and(eq(executions.workflow_id, workflowId), eq(executions.request_source, "webhook")))
      .orderBy(desc(executions.created_at))
      .limit(1);
    expect(admitted?.input).toMatchObject({ id: webhookId, body: { raw: RAW } });

    await activate(reportVersionId);
    const res = await prepare();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ prepared: true });
    expect(text).not.toContain(RAW);
    expect(text).not.toContain("admitted-sample-marker");
    const runs = await heldRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toEqual(admitted?.input);
  });
});
