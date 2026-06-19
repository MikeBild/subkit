// User story: As a partner system, I want to trigger a workflow by
// signing a Standard Webhooks POST, so that external events flow into
// the engine without pre-shared access tokens.
// Acceptance criteria:
//   - AC1: A valid Standard-Webhooks signature enqueues an execution.
//   - AC2: A stale timestamp is denied.
//   - AC3: A duplicate webhook-id is deduped.
// Spec refs: docs/03-input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
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

  // Create an inbound binding that maps the slug to the workflow.
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

describe("journey: inbound webhook triggers execution", () => {
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

    // Execution row exists for the workflow.
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
});
