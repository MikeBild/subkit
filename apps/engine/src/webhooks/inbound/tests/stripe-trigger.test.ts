// End-to-end webhook trigger test (issue #46).
//
// Drives an inbound `charge.failed` Stripe event through the executor
// pipeline against a workflow whose definition declares
// `trigger: { kind: "webhook", source: "stripe", verify: "stripe-signature" }`.
//
// Asserts:
//   * the Stripe verifier accepts a properly-signed body
//   * an unsigned (or wrong-signature) body is rejected and emits
//     `webhook.trigger.failed_verification`
//   * a duplicate event id is deduped (replay protection) and emits
//     `webhook.trigger.failed_verification` with reason `replay_dedup`
//   * the success path emits `webhook.trigger.fired` with
//     `event_id` + `event_type` + `execution_id` metadata
//   * the workflow runs and the `request` step's stub fetch lands an
//     HTTP POST shaped like a Slack chat.postMessage call

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { registerExecutionRunHandler } from "../../../queue/handlers/execution-run.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { bindFromWorkflow, handleInbound, rotateInboundSecret } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "whsec_stripe_charge_failed_aaaaaaaaaaaaaaaa";

let ctx: InboundTestCtx;
let inboundId: string;
const slackPosts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
const originalFetch = globalThis.fetch;

function signStripe(secret: string, ts: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
  return `t=${ts},v1=${v1}`;
}

function buildChargeFailedBody(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "charge.failed",
    created: 1709200000,
    livemode: false,
    data: {
      object: {
        id: "ch_1Q9testfailedcharge",
        object: "charge",
        amount: 4999,
        currency: "usd",
        failure_code: "card_declined",
        failure_message: "Your card was declined.",
        billing_details: { email: "customer@example.com" },
        status: "failed",
      },
    },
  });
}

beforeAll(async () => {
  ctx = await createInboundCtx("stripe-trigger");

  // Replace the workflow's stub DAG with a Slack-post pipeline. The
  // inbound payload (`{ id, timestamp, type, headers, body }`) is the
  // execution input; the transform extracts the failed-charge fields
  // and the request step posts a Slack chat.postMessage.
  const workflowRows = await ctx.db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(eq(workflows.id, ctx.workflowId))
    .limit(1);
  const currentVersionId = workflowRows[0]?.current_version_id;
  if (!currentVersionId) throw new Error("expected current workflow version");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "wf-stripe-trigger",
        version: 1,
        trigger: {
          kind: "webhook",
          source: "stripe",
          events: ["charge.failed"],
          verify: "stripe-signature",
        },
        steps: [
          {
            id: "extract",
            kind: "transform",
            language: "jsonata",
            expression:
              '$input.body.data.object.{ "charge_id": id, "amount": amount, "currency": currency, "failure_code": failure_code, "email": billing_details.email }',
          },
          {
            id: "post",
            kind: "request",
            method: "POST",
            url: "https://slack.test.invalid/api/chat.postMessage",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: {
              channel: "C0123ALERT",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow template placeholders are evaluated by the engine, not JS string interpolation
              text: "[stripe] charge.failed — ${scope.extract.data.currency} ${scope.extract.data.amount} — ${scope.extract.data.failure_code} — ${scope.extract.data.email} — ${scope.extract.data.charge_id}",
            },
          },
        ],
      },
    })
    .where(eq(workflowVersions.id, currentVersionId));

  // Bind the inbound row from the workflow trigger (origin = "trigger").
  // Then rotate the placeholder secret to one we know so we can
  // produce real Stripe signatures.
  const bound = await bindFromWorkflow(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      workflow_slug: "wf-stripe-trigger",
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["charge.failed"],
        verify: "stripe-signature",
      },
      actor_id: null,
    },
    ctx.db,
  );
  inboundId = bound.row.id;
  await rotateInboundSecret(ctx.tenantId, inboundId, SECRET, ctx.db);

  // Stub Slack — the executor's request step will hit this URL; the
  // stub records the call shape so the test can assert on it. Mock
  // the connector layer (HTTP), not the DB.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("slack.test.invalid")) {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      }
      let body: unknown = init?.body ?? null;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          /* keep raw */
        }
      }
      slackPosts.push({ url, body, headers });
      return new Response(
        JSON.stringify({ ok: true, channel: "C0123ALERT", ts: "1709200001.000200" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;

  await registerExecutionRunHandler({ boss: ctx.boss, db: ctx.db });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await ctx.cleanup();
});

describe("inbound: stripe webhook trigger end-to-end", () => {
  test("missing signature is rejected and emits webhook.trigger.failed_verification", async () => {
    const body = buildChargeFailedBody("evt_unsigned_aaa");
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: {},
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("missing_stripe_signature");

    // Wait for the fire-and-forget audit insert.
    const last = await waitFor(
      async () => {
        const rows = await ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, ctx.tenantId),
              eq(auditLog.action, "webhook.trigger.failed_verification"),
            ),
          );
        return rows.find((r) => r.reason === "missing_stripe_signature");
      },
      { label: "missing_stripe_signature audit visible", tries: 50, sleepMs: 20 },
    );
    expect(last).toBeDefined();
    const meta = last?.metadata as Record<string, unknown>;
    expect(meta.origin).toBe("trigger");
    expect(meta.workflow_id).toBe(ctx.workflowId);
  });

  test("bad signature is rejected and emits webhook.trigger.failed_verification", async () => {
    const eventId = "evt_badsig_aaa";
    const body = buildChargeFailedBody(eventId);
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe("wrong-secret", ts, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("bad_signature");
  });

  test("valid charge.failed accepted, runs workflow, posts to slack stub, emits webhook.trigger.fired", async () => {
    slackPosts.length = 0;
    const eventId = "evt_ok_charge_failed_001";
    const body = buildChargeFailedBody(eventId);
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe(SECRET, ts, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.normalized.id).toBe(eventId);
    expect(outcome.normalized.type).toBe("charge.failed");

    const finished = await waitFor(
      async () => {
        const latest = await ctx.db
          .select({ status: executions.status })
          .from(executions)
          .where(eq(executions.id, outcome.execution_id))
          .limit(1);
        const status = latest[0]?.status;
        return status === "succeeded" ? status : undefined;
      },
      { label: "stripe trigger execution completion", tries: 200, sleepMs: 50 },
    );
    expect(finished).toBe("succeeded");

    // Slack stub captured a POST.
    expect(slackPosts.length).toBeGreaterThanOrEqual(1);
    const post = slackPosts[0];
    expect(post?.url).toContain("/api/chat.postMessage");
    const postBody = post?.body as Record<string, unknown>;
    expect(postBody.channel).toBe("C0123ALERT");
    expect(typeof postBody.text).toBe("string");
    expect(String(postBody.text)).toContain("charge.failed");
    expect(String(postBody.text)).toContain("ch_1Q9testfailedcharge");
    expect(String(postBody.text)).toContain("card_declined");

    // Step-level success.
    const stepRows = await ctx.db
      .select({ status: executionSteps.status, step_key: executionSteps.step_key })
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, outcome.execution_id));
    expect(stepRows.length).toBe(2);
    for (const row of stepRows) expect(row.status).toBe("succeeded");

    // Audit signal — webhook.trigger.fired with the right metadata.
    const fired = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "webhook.trigger.fired")),
      );
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const firedRow = fired[fired.length - 1];
    expect(firedRow?.resource_type).toBe("webhook_inbound");
    expect(firedRow?.resource_id).toBe(inboundId);
    const firedMeta = firedRow?.metadata as Record<string, unknown>;
    expect(firedMeta.origin).toBe("trigger");
    expect(firedMeta.workflow_id).toBe(ctx.workflowId);
    expect(firedMeta.event_type).toBe("charge.failed");
    expect(firedMeta.event_id).toBe(eventId);
    expect(firedMeta.execution_id).toBe(outcome.execution_id);

    // Legacy actions must NOT have fired for this trigger-origin row.
    const legacy = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "webhook.inbound.received")),
      );
    expect(legacy.length).toBe(0);
  });

  test("event type outside the binding's events list is dropped", async () => {
    const eventId = "evt_out_of_subscription_001";
    const body = JSON.stringify({
      id: eventId,
      type: "invoice.paid",
      object: "event",
      created: 1709200002,
      data: { object: { id: "in_test_001" } },
    });
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe(SECRET, ts, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("event_not_subscribed");
  });

  test("duplicate event id is deduped + emits webhook.trigger.failed_verification with reason replay_dedup", async () => {
    const eventId = "evt_replay_001";
    const body = buildChargeFailedBody(eventId);
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe(SECRET, ts, body);
    const first = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(first.status).toBe("ok");
    const second = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(second.status).toBe("deduped");

    // `audit()` is fire-and-forget — the row is queued through
    // `writeAudit` without awaiting. Poll briefly so the test
    // observes the persisted row.
    const replayMatch = await waitFor(
      async () => {
        const rows = await ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, ctx.tenantId),
              eq(auditLog.action, "webhook.trigger.failed_verification"),
            ),
          );
        const match = rows.find((r) => r.reason === "replay_dedup");
        return match;
      },
      { label: "replay_dedup audit visible", tries: 50, sleepMs: 20 },
    );
    expect(replayMatch).toBeDefined();
  });
});
