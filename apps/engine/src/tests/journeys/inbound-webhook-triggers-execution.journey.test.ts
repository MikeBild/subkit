import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { withSystemScope } from "../../db/index.ts";
import { executions, webhookHeldDeliveries, webhooksInbound } from "../../db/schema/index.ts";
import { grantScheduleAuthorityFixture } from "../../scheduler/tests/authority-fixture.ts";
import { HELD_DELIVERY_LIMITS } from "../../webhooks/inbound/core/held-delivery.ts";
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
  test("a valid signature without execution authority is accepted as held, not run", async () => {
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
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "held", reason: "execution_authority_required" });
    expect(
      await ctx.db.select().from(executions).where(eq(executions.workflow_id, wf.id)),
    ).toHaveLength(0);
    const deliver = (id: string, payload: string) =>
      fetch(`${ctx.baseUrl}/v1/hooks/unapproved-events`, {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(ts),
          "webhook-signature": sign(id, ts, payload),
        },
      });
    const oversized = await deliver(
      "oversized-event",
      `{"blob":"${"x".repeat(HELD_DELIVERY_LIMITS.max_body_bytes)}"}`,
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ reason: "held_delivery_too_large" });
    const [hook] = await ctx.db
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(eq(webhooksInbound.slug, "unapproved-events"));
    await withSystemScope(ctx.db, "journey fills the held deliveries of one hook", (tx) =>
      tx.insert(webhookHeldDeliveries).values(
        Array.from({ length: HELD_DELIVERY_LIMITS.per_hook }, (_, index) => ({
          tenant_id: ctx.tenantId,
          inbound_id: hook?.id ?? "",
          workflow_id: wf.id,
          delivery_id: `filler-${index}`,
          event_type: "invoice.paid",
          payload: {},
          body_bytes: 2,
          reason_code: "execution_authority_required",
          expires_at: sql`clock_timestamp() + interval '1 hour'`,
        })),
      ),
    );
    const full = await deliver("over-capacity-event", body);
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ reason: "held_delivery_over_capacity" });
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
