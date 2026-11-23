import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { grantScheduleAuthorityFixture } from "../../scheduler/tests/authority-fixture.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const SECRET = "whsec_j4_standardaaaaaaaaaaaaaaaa";

function sign(id: string, ts: number, body: string): string {
  return `v1,${createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

let ctx: JourneyCtx;
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("inbound-wh");
  const wf = await seedWorkflow(ctx, {
    slug: "invoice-trigger",
    name: "Invoice Trigger",
    steps: [{ id: "noop", kind: "transform", expression: "$" }],
  });
  workflowId = wf.id;
  await grantScheduleAuthorityFixture(ctx.db, ctx.tenantId, workflowId);

  const bindRes = await journeyFetch(ctx, "/v1/webhooks/inbound", {
    method: "POST",
    body: JSON.stringify({
      slug: "invoice-trigger",
      workflow_id: workflowId,
      verifier: "standard",
      secret: SECRET,
    }),
  });
  expect(bindRes.status).toBe(201);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("inbound webhook triggers execution", () => {
  test("a valid signature without execution authority returns an actionable 409", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "unapproved-events",
      name: "Unapproved events",
      steps: [{ id: "noop", kind: "transform", expression: "$" }],
    });
    const binding = await journeyFetch(ctx, "/v1/webhooks/inbound", {
      method: "POST",
      body: JSON.stringify({
        slug: "unapproved-events",
        workflow_id: wf.id,
        verifier: "standard",
        secret: SECRET,
      }),
    });
    expect(binding.status).toBe(201);
    const body = '{"invoice":42}';
    const webhookId = "authority-required-event";
    // allow-wall-clock: the HTTP ingress verifies the live signature window.
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${ctx.baseUrl}/v1/hooks/unapproved-events`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(webhookId, ts, body),
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "denied",
      reason: "execution_authority_required",
      hint: expect.stringContaining("finite execution authority"),
    });
    expect(
      await ctx.db.select().from(executions).where(eq(executions.workflow_id, wf.id)),
    ).toHaveLength(0);
  });

  test("AC1: valid signature accepted and execution enqueued", async () => {
    const body = JSON.stringify({ invoice: { id: 1, amount: 100 } });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${ctx.baseUrl}/v1/hooks/invoice-trigger`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(webhookId, ts, body),
        "webhook-type": "invoice.paid",
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; execution_id: string };
    expect(out.accepted).toBe(true);
    expect(out.execution_id).toBeTruthy();

    const rows = await ctx.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, workflowId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("AC2: stale timestamp denied", async () => {
    const body = JSON.stringify({ stale: true });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await fetch(`${ctx.baseUrl}/v1/hooks/invoice-trigger`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(webhookId, ts, body),
      },
    });
    expect(res.status).toBe(401);
    const out = (await res.json()) as { reason: string };
    expect(out.reason).toBe("timestamp_outside_window");
  });

  test("AC3: duplicate webhook-id deduped", async () => {
    const body = JSON.stringify({ replay: "yes" });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(webhookId, ts, body);
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(ts),
      "webhook-signature": sig,
    };
    const first = await fetch(`${ctx.baseUrl}/v1/hooks/invoice-trigger`, {
      method: "POST",
      body,
      headers,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { accepted?: boolean; deduped?: boolean };
    expect(firstBody.accepted).toBe(true);

    const second = await fetch(`${ctx.baseUrl}/v1/hooks/invoice-trigger`, {
      method: "POST",
      body,
      headers,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { deduped?: boolean };
    expect(secondBody.deduped).toBe(true);
  });

  test("AC4: an hmac binding refuses an invalid scheme and accepts a signed POST", async () => {
    const refused = await journeyFetch(ctx, "/v1/webhooks/inbound", {
      method: "POST",
      body: JSON.stringify({
        slug: "hmac-events-bad",
        workflow_id: workflowId,
        verifier: "hmac",
        secret: SECRET,
        native_verifier_config: { hmac: { signature_header: "x-sig", signed_payload: "{id}" } },
      }),
    });
    expect(refused.status).toBe(400);

    const bound = await journeyFetch(ctx, "/v1/webhooks/inbound", {
      method: "POST",
      body: JSON.stringify({
        slug: "hmac-events",
        workflow_id: workflowId,
        verifier: "hmac",
        secret: SECRET,
        native_verifier_config: {
          hmac: {
            signature_header: "X-Example-Signature",
            signature_prefix: "v1=",
            signed_payload: "v1:{timestamp}:{body}",
            timestamp_header: "X-Example-Timestamp",
            id_header: "X-Example-Message-Id",
          },
        },
      }),
    });
    expect(bound.status).toBe(201);

    const body = JSON.stringify({ eventType: "thing.happened" });
    // allow-wall-clock: the HTTP ingress verifies the live signature window.
    const ts = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", SECRET).update(`v1:${ts}:${body}`).digest("hex");
    const res = await fetch(`${ctx.baseUrl}/v1/hooks/hmac-events`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "X-Example-Signature": `v1=${digest}`,
        "X-Example-Timestamp": String(ts),
        "X-Example-Message-Id": "hmac-journey-1",
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; webhook_id: string };
    expect(out.accepted).toBe(true);
    expect(out.webhook_id).toBe("hmac-journey-1");
  });
});
