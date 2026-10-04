import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { executions } from "../../../db/schema/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../../queue/queues.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "whsec_standardabcdefghijklmnopqrst";

function sign(secret: string, id: string, ts: number, body: string): string {
  return `v1,${createHmac("sha256", secret)
    .update(`${id}.${ts}.${body}`, "utf8")
    .digest("base64")}`;
}

const deterministicUuid = createDeterministicUuidFactory(0xd15ea5e);

let ctx: InboundTestCtx;
let bindingId: string;

beforeAll(async () => {
  ctx = await createInboundCtx("standard");
  await ctx.grantAuthority();
  const row = await ctx.createBinding({
    slug: "invoice-trigger",
    verifier: "standard",
    secret: SECRET,
  });
  bindingId = row.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("inbound: standard webhooks", () => {
  test("valid signature accepted and execution enqueued", async () => {
    const body = JSON.stringify({ ping: "pong" });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, webhookId, ts, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sig,
          "webhook-type": "invoice.paid",
        },
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.execution_id).toBeString();
    expect(outcome.normalized.id).toBe(webhookId);
    expect(outcome.normalized.type).toBe("invoice.paid");
    expect(bindingId).toBe(outcome.inbound_id);
  });

  test("bad signature rejected", async () => {
    const body = JSON.stringify({ ping: "pong" });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const badSig = sign("wrong-secret", webhookId, ts, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": badSig,
        },
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("bad_signature");
  });

  test("stale timestamp rejected", async () => {
    const body = JSON.stringify({ ping: "pong" });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const staleTs = Math.floor(Date.now() / 1000) - 10 * 60;
    const sig = sign(SECRET, webhookId, staleTs, body);
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(staleTs),
          "webhook-signature": sig,
        },
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("timestamp_outside_window");
  });

  test("duplicate webhook-id deduped", async () => {
    const body = JSON.stringify({ replay: true });
    const webhookId = randomUUID(); // allow-random: legacy; review before changing
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(SECRET, webhookId, ts, body);
    const first = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sig,
        },
      },
    );
    expect(first.status).toBe("ok");
    const second = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sig,
        },
      },
    );
    expect(second.status).toBe("deduped");
  });

  test("an accepted delivery runs against PROD connectors", async () => {
    const body = JSON.stringify({ invoice: "prod-mode" });
    const ts = Math.floor(getTestNow() / 1000);
    const webhookId = deterministicUuid();
    const result = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      {
        slug: "invoice-trigger",
        rawBody: body,
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sign(SECRET, webhookId, ts, body),
        },
      },
    );
    expect(result.status).toBe("ok");
    const rows = await ctx.db.select().from(executions);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.execution_mode).toBe("prod");

    const jobs = await ctx.db.execute(
      sql`SELECT data FROM pgboss.job WHERE name = ${EXECUTION_RUN_QUEUE}`,
    );
    const queued = (jobs.rows ?? jobs) as { data: { execution_mode?: string } }[];
    expect(queued.length).toBeGreaterThan(0);
    for (const job of queued) expect(job.data.execution_mode).toBe("prod");
  });
});
