import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { executions, workflowVersions } from "../../db/schema/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const SECRET = "whsec_j59_standardaaaaaaaaaaaaaaa";
const HOOK = "findings-inbox";

function sign(id: string, ts: number, body: string): string {
  return `v1,${createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

let ctx: JourneyCtx;
let workflowId = "";
let versionId = "";

const heldRuns = async () =>
  ctx.db
    .select({ id: executions.id, input: executions.input })
    .from(executions)
    .where(and(eq(executions.workflow_id, workflowId), eq(executions.hold_writes, true)));

const prepare = (body: Record<string, unknown>) =>
  journeyFetch(ctx, `/v1/workflows/${workflowId}/versions/${versionId}/prepare-authority`, {
    method: "POST",
    body: JSON.stringify({ environment: "prod", ...body }),
  });

beforeAll(async () => {
  ctx = await createJourneyCtx("webhook-hold");
  const notify = {
    id: "notify",
    kind: "request",
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression
    body: { raw: "${input.body.raw}" },
    max_retries: 0,
  };
  const wf = await seedWorkflow(ctx, {
    slug: "finding-triage",
    name: "Finding triage",
    steps: [notify],
  });
  workflowId = wf.id;
  versionId = wf.version_id;
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Finding triage",
        slug: "finding-triage",
        input_schema: {
          type: "object",
          required: ["body"],
          properties: { body: { type: "object" } },
        },
        steps: [notify],
      },
    })
    .where(eq(workflowVersions.id, versionId));
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
  const body = JSON.stringify({ raw: "cmVmdXNlZA" });
  const webhookId = "refused-delivery";
  // allow-wall-clock: the HTTP ingress verifies the live signature window.
  const ts = Math.floor(Date.now() / 1000);
  const refused = await fetch(`${ctx.baseUrl}/v1/hooks/${HOOK}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(ts),
      "webhook-signature": sign(webhookId, ts, body),
    },
  });
  expect(refused.status).toBe(409);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a refused webhook is actionable", () => {
  test("AC1: the attention item names the waiting webhook", async () => {
    const res = await journeyFetch(ctx, "/v1/attention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; reason: string; trigger?: unknown }>;
    };
    const item = body.items.find((entry) => entry.id === `workflow:${workflowId}`);
    expect(item?.reason).toMatch(/^execution_authority_/);
    expect(item?.trigger).toEqual({ kind: "inbound_hook", name: HOOK });
  });

  test("AC2: preparing without an input asks for one and starts nothing", async () => {
    const before = (await heldRuns()).length;
    const res = await prepare({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prepared: false,
      reason: "input_required",
      trigger: { kind: "inbound_hook", slug: HOOK },
    });
    expect((await heldRuns()).length).toBe(before);
  });

  test("AC3: a sample violating the input schema is refused before any run", async () => {
    const before = (await heldRuns()).length;
    const res = await prepare({ input: { id: "no-body" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("input_schema_violation");
    expect((await heldRuns()).length).toBe(before);
  });

  test("AC3: preparing with a sample delivery runs held with exactly that input", async () => {
    const sample = {
      id: "sample-delivery",
      timestamp: 1_700_000_000,
      type: "finding.created",
      headers: {},
      body: { raw: "c2FtcGxl" },
    };
    const res = await prepare({ input: sample });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prepared: true,
      diagnoses: [
        {
          code: "report_delivery_unobserved",
          reason: "missing_headers",
          step_id: "notify",
          remedy_kind: "author",
        },
      ],
    });
    const runs = await heldRuns();
    expect(runs.map((run) => run.input)).toContainEqual(sample);
  });
});
