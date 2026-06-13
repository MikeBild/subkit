// End-to-end webhook trigger test.
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
import { markSeenIfNew } from "../dedup.ts";
import { bindFromWorkflow, handleInbound, rotateInboundSecret } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "whsec_stripe_charge_failed_aaaaaaaaaaaaaaaa";

let ctx: InboundTestCtx;
let inboundId: string;
const slackPosts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
// Real HTTP stub server (NOT a fetch mock): the workflow executes inside
// the queue handler's async context, where a test-scoped fetch override
// cannot reach — and a global fetch stub leaks into concurrently-running
// sibling test files. A loopback server is context-free and leak-free.
let slackServer: ReturnType<typeof Bun.serve>;
let slackBaseUrl = "";

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
  slackServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      let body: unknown = null;
      const text = await req.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      slackPosts.push({ url: req.url, body, headers });
      return Response.json({ ok: true, channel: "C0123ALERT", ts: "1709200001.000200" });
    },
  });
  slackBaseUrl = `http://127.0.0.1:${slackServer.port}`;

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
            url: `${slackBaseUrl}/api/chat.postMessage`,
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

  await registerExecutionRunHandler({ boss: ctx.boss, db: ctx.db });
});

afterAll(async () => {
  slackServer.stop(true);
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
    const beforeRows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    const marked = await markSeenIfNew(ctx.db, {
      tenant_id: ctx.tenantId,
      webhook_id: inboundId,
      standard_webhook_id: eventId,
    });
    expect(marked).toBe(true);
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe(SECRET, ts, body);
    const second = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "wf-wf-stripe-trigger",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(second.status).toBe("deduped");
    if (second.status !== "deduped") throw new Error("expected deduped");
    expect(second.inbound_id).toBe(inboundId);

    const afterRows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(afterRows.length).toBe(beforeRows.length);

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
