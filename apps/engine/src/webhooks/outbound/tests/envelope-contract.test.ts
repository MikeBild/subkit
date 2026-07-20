// Contract test: pins the outbound webhook wire envelope — the exact
// HTTP headers and JSON body wrapper a subscriber actually receives —
// so a change to header names, the signature scheme, or the envelope
// shape fails loudly instead of only being caught by a payload-field
// diff. Header capture uses `fetchImpl` (the same test seam the
// delivery worker already exposes) rather than a real HTTP server, so
// the assertion pins the *application-controlled* header set the code
// constructs, not incidental transport headers (Host, Connection,
// Accept-Encoding, Content-Length) added by the underlying fetch
// client — those are not part of subkit's envelope contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog, deliveries } from "../../../db/schema/index.ts";
import { EVENT_CATALOG } from "../../events/catalog.ts";
import type { WebhookDeliverJob } from "../delivery-worker.ts";
import { registerDeliveryWorker, WEBHOOK_DELIVER_QUEUE } from "../delivery-worker.ts";
import { fanoutEvent } from "../fanout.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

let ctx: OutboundTestCtx;

beforeAll(async () => {
  ctx = await createOutboundCtx("envelope-contract");
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Captures exactly the (url, headers, body) triple the worker hands to `fetch`. */
interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

describe("outbound: wire envelope contract", () => {
  test("execution.succeeded: header set, signature format, and body envelope keys are pinned", async () => {
    const sub = await ctx.createSub({
      event_pattern: "execution.*",
      target_url: "http://127.0.0.1:9/hook",
      secret: "whsec_envelopecontractaaaaaaaaaa",
    });

    const payload = EVENT_CATALOG["execution.succeeded"].example;
    const stats = await fanoutEvent({
      db: ctx.db,
      boss: ctx.boss,
      tenant_id: ctx.tenantId,
      event_row_id: 900301,
      event_type: "execution.succeeded",
      payload,
    });
    expect(stats.matched).toBe(1);
    expect(stats.enqueued).toBe(1);

    const jobs = await ctx.boss.fetch<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE, {
      batchSize: 5,
    });
    const job = jobs?.[0];
    if (!job) throw new Error("expected exactly one enqueued webhook.deliver job");

    // --- body envelope wrapper: exact top-level key set + stable fields ---
    const envelope = JSON.parse(job.data.body) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["data", "timestamp", "type"]);
    expect(envelope.type).toBe("execution.succeeded");
    expect(typeof envelope.timestamp).toBe("number");
    expect(envelope.data).toEqual(payload);

    // --- deliver it, capturing exactly what the worker hands to fetch() ---
    let captured: CapturedRequest | null = null;
    const fetchImpl = (async (url, init) => {
      captured = {
        url: String(url),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        bodyText: String(init?.body ?? ""),
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { handle } = await registerDeliveryWorker({
      boss: ctx.boss,
      db: ctx.db,
      fetchImpl,
      jitter: false,
      noWork: true,
    });
    await handle({
      id: job.id,
      name: WEBHOOK_DELIVER_QUEUE,
      data: job.data,
    } as unknown as Job<WebhookDeliverJob>);
    await ctx.boss.complete(WEBHOOK_DELIVER_QUEUE, job.id);

    if (!captured) throw new Error("delivery worker never called fetchImpl");
    const req: CapturedRequest = captured;

    // --- header set: exact names, sorted ---
    expect(Object.keys(req.headers).sort()).toEqual([
      "content-type",
      "user-agent",
      "webhook-id",
      "webhook-signature",
      "webhook-timestamp",
    ]);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe("subkit-webhooks/1");
    expect(req.headers["webhook-id"]).toBe(job.data.webhook_id);
    expect(req.headers["webhook-timestamp"]).toBe(String(job.data.timestamp));
    expect(req.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    // Signature scheme: `v1,<base64(HMAC-SHA256)>` — one token (no
    // rotating secret configured for this subscription), 44-char base64
    // digest with the standard single trailing `=` pad.
    expect(req.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);

    // --- body on the wire is passed through byte-for-byte ---
    expect(req.bodyText).toBe(job.data.body);

    // --- state mutation is audited ---
    const rows = await ctx.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscription_id, sub.id), eq(deliveries.tenant_id, ctx.tenantId)));
    expect(rows[0]?.status).toBe("success");

    const audits = await ctx.db
      .select({ action: auditLog.action, resource_id: auditLog.resource_id })
      .from(auditLog)
      .where(eq(auditLog.resource_id, sub.id));
    const delivered = audits.find((a) => a.action === AuditAction.WEBHOOK_OUTBOUND_DELIVERED);
    expect(delivered).toBeDefined();
  });
});
